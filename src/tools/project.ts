import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compareLines, type NumberedLine } from "../diff.js";
import { compactProject, compactStats } from "../format.js";
import { ASYNC_NOTE, DELETE, OVERWRITE, READ_ONLY, WRITE, checkLocales, id, locale, run, type ToolContext } from "./common.js";

const DATE_RANGE = /^\d+\.(day|week|month|year)s?\.ago$/;
const DEFAULT_MAX_CHARS = 30_000;
/** Lines listed per side in an upload preview; the counts are always complete. */
const MAX_PREVIEW_LINES = 40;

/**
 * Ties a confirmation to what the preview compared: the token changes as soon as the local file or
 * WebTranslateIt's copy does, so an upload can't go through on a stale preview.
 */
function previewToken(fileId: number, locale: string, remote: string, local: Buffer): string {
  return createHash("sha256")
    .update(`${fileId}\0${locale}\0`)
    .update(remote)
    .update("\0")
    .update(local)
    .digest("hex")
    .slice(0, 16);
}

function listLines(lines: NumberedLine[]) {
  return {
    count: lines.length,
    lines: lines.slice(0, MAX_PREVIEW_LINES).map((entry) => `${entry.line}: ${entry.text.slice(0, 200)}`),
    ...(lines.length > MAX_PREVIEW_LINES ? { more: lines.length - MAX_PREVIEW_LINES } : {}),
  };
}

function uploadEffects(isMasterFile: boolean, merge: boolean, ignoreMissing: boolean): string[] {
  const effects = [
    merge
      ? "Strings whose text differs keep WebTranslateIt's text (merge: true); only strings it doesn't have are added."
      : "Strings whose text differs get your file's text, replacing what is on WebTranslateIt (merge: false).",
  ];
  if (!isMasterFile) {
    effects.push("Translations of strings that aren't in your file aren't touched.");
  } else if (ignoreMissing) {
    effects.push("Strings that are only on WebTranslateIt stay as they are (ignore_missing: true).");
  } else {
    effects.push("Strings that are only on WebTranslateIt are marked obsolete (ignore_missing: false).");
  }
  return effects;
}

export function registerProjectTools(server: McpServer, { client, readOnly, allowDelete }: ToolContext): void {
  server.registerTool(
    "wti_get_project",
    {
      title: "Get project info",
      description:
        "Project name, source and target locales, and master files with their file id per locale. Start here to " +
        "get the file ids the other tools need.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => run(async () => compactProject(await client.getProject(true))),
  );

  server.registerTool(
    "wti_get_stats",
    {
      title: "Get translation progress",
      description:
        "Translation progress per locale: number of strings done, to translate, to verify and to proofread, and the " +
        "percentage done. Filter by file, label or category id, or by how recently strings were added or changed.",
      inputSchema: {
        locale: locale().optional().describe("Only return this locale."),
        file_id: id("Only count strings of this master file.").optional(),
        label_id: id("Only count strings with this label id (an id, not a name).").optional(),
        category_id: id("Only count strings of this category id.").optional(),
        added_since: z
          .string()
          .regex(DATE_RANGE)
          .optional()
          .describe('Only strings added in this period, e.g. "7.days.ago" or "1.month.ago".'),
        modified_since: z
          .string()
          .regex(DATE_RANGE)
          .optional()
          .describe('Only translations changed in this period, e.g. "2.weeks.ago".'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        if (args.locale) await checkLocales(client, [args.locale]);
        const stats = await client.getStats({
          file: args.file_id,
          label: args.label_id,
          category: args.category_id,
          date_range: args.added_since,
          modification_date_range: args.modified_since,
        });
        return compactStats(stats, args.locale);
      }),
  );

  server.registerTool(
    "wti_download_file",
    {
      title: "Download a language file",
      description:
        "Download a language file (e.g. strings.xml, en.json, Localizable.strings) for one locale, as WebTranslateIt " +
        "would export it, like `wti pull` does for one file. Returns the content, or writes it to `save_to`.",
      inputSchema: {
        file_id: id("Master file id from wti_get_project (master_files[].master_file_id)."),
        locale: locale(),
        save_to: z
          .string()
          .optional()
          .describe("Write the file to this local path instead of returning it (relative to the server's working directory)."),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(500_000)
          .optional()
          .describe(`When returning the content, cut it after this many characters (default ${DEFAULT_MAX_CHARS}).`),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        await checkLocales(client, [args.locale]);
        const content = await client.downloadFile(args.file_id, args.locale);
        if (args.save_to) {
          const path = resolve(args.save_to);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, content, "utf8");
          return { saved_to: path, bytes: Buffer.byteLength(content) };
        }
        const limit = args.max_chars ?? DEFAULT_MAX_CHARS;
        if (content.length <= limit) return content;
        return `${content.slice(0, limit)}\n…[cut: ${content.length - limit} more characters. Pass save_to, or a larger max_chars]`;
      }),
  );

  if (readOnly) return;

  server.registerTool(
    "wti_upload_file",
    {
      title: "Upload a language file",
      description:
        "Upload a local language file to a file and locale on WebTranslateIt, like `wti push` does for one file. " +
        "Called without `confirm`, it uploads nothing: it downloads WebTranslateIt's current copy and returns the " +
        "lines that are only there (changes by other people that the upload could overwrite) and the lines that are " +
        "only in your file. Show them to the user, then call again with the `confirm` token to upload. The import " +
        "runs in the background. By default strings missing from the upload are kept (ignore_missing: true).",
      inputSchema: {
        file_id: id("Master file id from wti_get_project."),
        locale: locale().describe("Locale of the uploaded file. Use the source locale to update the master file."),
        local_path: z.string().min(1).describe("Path of the local file to upload."),
        merge: z
          .boolean()
          .optional()
          .describe("Merge with the existing translations instead of overwriting them (default false)."),
        ignore_missing: z
          .boolean()
          .optional()
          .describe(
            "Keep strings that are missing from the uploaded file (default true here; the API's default is false). " +
              "Set false to mark them obsolete, to sync deletions from a complete master file.",
          ),
        minor_changes: z
          .boolean()
          .optional()
          .describe("Master file only: don't flag the target translations as 'to verify'."),
        label: z.string().optional().describe("Label applied to every string this upload changes."),
        confirm: z
          .string()
          .optional()
          .describe(
            "The `confirm` token from this tool's preview. It only works while your file and WebTranslateIt's copy " +
              "are the ones the preview compared; if either changed, you get a new preview instead of an upload.",
          ),
      },
      annotations: OVERWRITE,
    },
    async (args) =>
      run(async () => {
        await checkLocales(client, [args.locale]);
        const path = resolve(args.local_path);
        const content = await readFile(path);
        const merge = args.merge ?? false;
        const ignoreMissing = args.ignore_missing ?? true;

        // The "pull before push": compare with what is on WebTranslateIt right now.
        const remote = await client.downloadFile(args.file_id, args.locale);
        const token = previewToken(args.file_id, args.locale, remote, content);

        if (args.confirm !== token) {
          const { onlyBefore, onlyAfter } = compareLines(remote, content.toString("utf8"));
          const target = { file_id: args.file_id, locale: args.locale, local_path: path };
          if (onlyBefore.length === 0 && onlyAfter.length === 0) {
            return {
              status: "unchanged",
              uploaded: false,
              ...target,
              note:
                "Your file has the same lines as WebTranslateIt's copy (ignoring order, indentation and blank lines), " +
                "so there is nothing to upload. Pass confirm to upload it anyway.",
              confirm: token,
            };
          }
          const project = await client.getProject();
          const notes: string[] = [];
          if (args.confirm) {
            notes.push(
              "Not uploaded: your file or WebTranslateIt's copy changed since that preview, so its token no longer " +
                "matches. These are the current differences.",
            );
          }
          if (onlyAfter.length === 0) {
            notes.push(
              "Your file has no lines that aren't on WebTranslateIt, so uploading it would add nothing: it is behind " +
                "WebTranslateIt's copy. Use wti_download_file to get the lines listed under only_on_webtranslateit.",
            );
          }
          return {
            status: "preview",
            uploaded: false,
            ...target,
            ...(notes.length ? { note: notes.join(" ") } : {}),
            only_on_webtranslateit: listLines(onlyBefore),
            only_in_your_file: listLines(onlyAfter),
            if_you_upload: uploadEffects(args.locale === project.source_locale?.code, merge, ignoreMissing),
            confirm: token,
            next_step:
              "Show these differences to the user. To upload, call wti_upload_file again with the same arguments " +
              `and confirm: "${token}".`,
          };
        }

        const form = new FormData();
        form.append("merge", String(merge));
        form.append("ignore_missing", String(ignoreMissing));
        form.append("minor_changes", String(args.minor_changes ?? false));
        if (args.label) form.append("label", args.label);
        form.append("file", new Blob([content]), basename(path));
        await client.uploadFile(args.file_id, args.locale, form);
        return {
          status: "uploaded",
          uploaded: true,
          file_id: args.file_id,
          locale: args.locale,
          local_path: path,
          bytes: content.byteLength,
          note: ASYNC_NOTE,
        };
      }),
  );

  server.registerTool(
    "wti_add_locale",
    {
      title: "Add a locale",
      description: "Add a target locale to the project.",
      inputSchema: { locale: locale() },
      annotations: WRITE,
    },
    async (args) =>
      run(async () => {
        await client.addLocale(args.locale);
        return { added_locale: args.locale, note: ASYNC_NOTE };
      }),
  );

  if (!allowDelete) return;

  server.registerTool(
    "wti_remove_locale",
    {
      title: "Remove a locale",
      description: "Remove a target locale from the project, with all its files and translations. This can't be undone.",
      inputSchema: { locale: locale() },
      annotations: DELETE,
    },
    async (args) =>
      run(async () => {
        await checkLocales(client, [args.locale]);
        await client.removeLocale(args.locale);
        return { removed_locale: args.locale, note: ASYNC_NOTE };
      }),
  );
}
