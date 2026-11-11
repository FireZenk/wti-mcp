import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RawProject, RawString, WtiClient } from "../client.js";
import { compactString, dropEmpty, normalizeLabels } from "../format.js";
import {
  ASYNC_NOTE,
  DELETE,
  InputError,
  OVERWRITE,
  READ_ONLY,
  WRITE,
  checkLocales,
  id,
  locale,
  run,
  splitLocales,
  type ToolContext,
} from "./common.js";

const STRING_STATUSES = ["current", "hidden", "obsolete"] as const;
const WORK_STATUSES = ["to_translate", "to_verify", "to_proofread", "done"] as const;
const TRANSLATION_STATUSES = ["status_unproofread", "status_proofread", "status_unverified"] as const;

const translationText = () =>
  z
    .union([z.string(), z.record(z.string(), z.string())])
    .describe(
      'Translation text. For plural strings pass an object keyed by plural form, e.g. {"one": "%d booking", "other": "%d bookings"}.',
    );

const translationInput = z.object({
  locale: locale(),
  text: translationText(),
  status: z
    .enum(TRANSLATION_STATUSES)
    .optional()
    .describe("status_unproofread (default), status_proofread or status_unverified."),
});

const stringRef = {
  string_id: id("Numeric id of the string. Pass this or `key`.").optional(),
  key: z.string().trim().min(1).optional().describe("Exact key of the string, e.g. `booking_confirm_title`. Pass this or `string_id`."),
  file_id: id("Master file id (see wti_get_project). Only needed when the same key exists in several files.").optional(),
};

interface StringRef {
  string_id?: number | undefined;
  key?: string | undefined;
  file_id?: number | undefined;
}

export async function findStringsByKey(client: WtiClient, key: string, fileId?: number): Promise<RawString[]> {
  const { items } = await client.listStrings({ "filters[key]": key, "filters[file]": fileId }, 10);
  return items.filter((string) => string.key === key && (!fileId || !string.file || string.file.id === fileId));
}

export async function resolveStringId(client: WtiClient, ref: StringRef): Promise<number> {
  if (ref.string_id) return ref.string_id;
  const key = ref.key?.trim();
  if (!key) throw new InputError("Pass `string_id` or `key`.");
  const matches = await findStringsByKey(client, key, ref.file_id);
  const inFile = ref.file_id ? ` in file ${ref.file_id}` : "";
  if (matches.length === 0) {
    throw new InputError(`No string with key "${key}"${inFile}. Use wti_list_strings with regex: true to look for similar keys.`);
  }
  if (matches.length > 1) {
    const where = matches.map((match) => `string_id ${match.id} (file_id ${match.file?.id ?? "?"})`).join(", ");
    throw new InputError(`Key "${key}" exists in several files: ${where}. Pass file_id or string_id.`);
  }
  return (matches[0] as RawString).id;
}

/** The project's only master file, so callers don't have to pass `file_id` in single-file projects. */
function defaultMasterFile(project: RawProject): number | undefined {
  const masters = (project.project_files ?? []).filter((file) => !file.master_project_file_id);
  if (masters.length <= 1) return masters[0]?.id;
  const options = masters.map((file) => `${file.id} (${file.name})`).join(", ");
  throw new InputError(`This project has several master files; pass file_id. Master files: ${options}.`);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function registerStringTools(server: McpServer, { client, readOnly, allowDelete }: ToolContext): void {
  server.registerTool(
    "wti_list_strings",
    {
      title: "List or search strings",
      description:
        "List strings (segments) of the WebTranslateIt project, 250 per page. Filter by key (exact, or a regular " +
        "expression with regex: true), label, file, status or creation date. Pass `locale` to include translations; " +
        "with status to_translate / to_verify / to_proofread / done it finds the work left in that locale.",
      inputSchema: {
        key: z.string().optional().describe("Key to match. Exact match unless `regex` is true, e.g. `^booking_` with regex."),
        regex: z.boolean().optional().describe("Treat `key` as a regular expression."),
        ignore_case: z.boolean().optional().describe("Case-insensitive regex."),
        status: z
          .enum([...STRING_STATUSES, ...WORK_STATUSES])
          .optional()
          .describe(
            "current / hidden / obsolete filter the string itself. to_translate / to_verify / to_proofread / done " +
              "filter by translation state and need a single `locale`.",
          ),
        locale: z
          .string()
          .trim()
          .optional()
          .describe('Include translations for this locale, several ("de,fr") or all ("*").'),
        label: z
          .string()
          .optional()
          .describe('Label name. "none" = no label, "a,b" = both, "|a,b" = either, "!a" = without a.'),
        category: z.string().optional().describe('Category name, or "none".'),
        file_id: id("Only strings of this master file.").optional(),
        created_after: z.string().optional().describe("Only strings added after this date, e.g. 2026-11-01."),
        page: z.number().int().min(1).optional().describe("Page to start from (default 1)."),
        max_pages: z.number().int().min(1).max(20).optional().describe("How many pages of 250 to fetch (default 1)."),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const workStatus = (WORK_STATUSES as readonly string[]).includes(args.status ?? "");
        if (workStatus && (!args.locale || /[,*]/.test(args.locale))) {
          throw new InputError(`status "${args.status}" needs one locale, e.g. locale: "de-DE".`);
        }
        await checkLocales(client, splitLocales(args.locale));
        const page = await client.listStrings(
          {
            "filters[key]": args.key,
            "filters[regex]": args.regex ? "true" : undefined,
            "filters[ignore_case]": args.ignore_case ? "true" : undefined,
            "filters[status]": args.status,
            "filters[label]": args.label,
            "filters[category]": args.category,
            "filters[file]": args.file_id,
            "filters[created_at]": args.created_after,
            locale: args.locale,
            page: args.page && args.page > 1 ? args.page : undefined,
          },
          args.max_pages ?? 1,
        );
        return { count: page.items.length, next_page: page.nextPage, strings: page.items.map(compactString) };
      }),
  );

  server.registerTool(
    "wti_get_string",
    {
      title: "Get a string and its translations",
      description:
        "Show one string by key or id with its translations: text and status per locale, labels, developer comment and file.",
      inputSchema: {
        ...stringRef,
        locales: z.string().trim().optional().describe('Locales to include: "*" for all (default) or a list such as "de,fr".'),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        await checkLocales(client, splitLocales(args.locales));
        const stringId = await resolveStringId(client, args);
        return compactString(await client.getString(stringId, args.locales || "*"));
      }),
  );

  if (readOnly) return;

  server.registerTool(
    "wti_create_string",
    {
      title: "Create a string",
      description:
        "Create a new string (key) in a master file, optionally with its source text and translations. Fails if the key " +
        "already exists in that file. In projects with one master file, file_id can be omitted.",
      inputSchema: {
        key: z.string().trim().min(1).max(255).describe("Key of the new string, e.g. `home_rebook_card_title`."),
        source_text: translationText().optional().describe("Text in the project's source locale."),
        translations: z.array(translationInput).optional().describe("Translations in other locales."),
        file_id: id("Master file to add the string to (see wti_get_project).").optional(),
        dev_comment: z
          .string()
          .optional()
          .describe("Context for translators: where the text shows, length limits, what placeholders mean."),
        labels: z.array(z.string().trim().min(1)).optional().describe('Labels, e.g. ["android", "release-5.31"].'),
        plural: z.boolean().optional().describe("Plural string. Set automatically when a text is a plural object."),
      },
      annotations: WRITE,
    },
    async (args) =>
      run(async () => {
        const project = await client.getProject();
        await checkLocales(client, (args.translations ?? []).map((translation) => translation.locale));
        const fileId = args.file_id ?? defaultMasterFile(project);
        if (fileId && (await findStringsByKey(client, args.key, fileId)).length > 0) {
          throw new InputError(
            `Key "${args.key}" already exists in file ${fileId}. Use wti_update_string or wti_set_translations instead.`,
          );
        }

        const sourceLocale = project.source_locale?.code;
        const translations: Record<string, unknown>[] = [];
        if (args.source_text !== undefined) {
          if (!sourceLocale) throw new InputError("The project has no source locale; pass the text in `translations`.");
          translations.push({ locale: sourceLocale, text: args.source_text });
        }
        for (const translation of args.translations ?? []) {
          if (args.source_text !== undefined && translation.locale === sourceLocale) {
            throw new InputError(`Both source_text and translations[] set the ${sourceLocale} text; keep one.`);
          }
          translations.push(dropEmpty({ ...translation }));
        }
        const hasPluralText = translations.some((translation) => typeof translation.text === "object");

        const body = dropEmpty({
          key: args.key,
          file: fileId ? { id: fileId } : undefined,
          dev_comment: args.dev_comment,
          labels: args.labels ? unique(args.labels).join(",") : undefined,
          plural: args.plural ?? (hasPluralText || undefined),
          translations: translations.length ? translations : undefined,
        });
        const created = await client.createString(body);
        return { created: created ? compactString(created) : { key: args.key, file_id: fileId } };
      }),
  );

  server.registerTool(
    "wti_update_string",
    {
      title: "Update a string",
      description:
        "Change a string's key, developer comment, labels or status (current / hidden / obsolete). Use add_labels / " +
        "remove_labels to change labels without replacing them. Translations are changed with wti_set_translations.",
      inputSchema: {
        ...stringRef,
        new_key: z.string().trim().min(1).max(255).optional().describe("Rename the key."),
        dev_comment: z.string().optional().describe("New developer comment. An empty string clears it."),
        labels: z.array(z.string()).optional().describe("Replace all labels with this list ([] removes them all)."),
        add_labels: z.array(z.string().trim().min(1)).optional().describe("Labels to add, keeping the existing ones."),
        remove_labels: z.array(z.string().trim().min(1)).optional().describe("Labels to remove."),
        status: z.enum(STRING_STATUSES).optional().describe("current, hidden (not shown to translators) or obsolete."),
        plural: z.boolean().optional(),
      },
      annotations: OVERWRITE,
    },
    async (args) =>
      run(async () => {
        if (args.labels && (args.add_labels || args.remove_labels)) {
          throw new InputError("Pass either `labels` or `add_labels` / `remove_labels`, not both.");
        }
        const stringId = await resolveStringId(client, args);
        const body: Record<string, unknown> = {};
        if (args.new_key) body.key = args.new_key;
        if (args.dev_comment !== undefined) body.dev_comment = args.dev_comment;
        if (args.status) body.status = args.status[0]?.toUpperCase() + args.status.slice(1);
        if (args.plural !== undefined) body.plural = args.plural;
        if (args.labels) {
          body.labels = unique(args.labels).join(",");
        } else if (args.add_labels || args.remove_labels) {
          const current = normalizeLabels((await client.getString(stringId)).labels);
          const removed = new Set(args.remove_labels ?? []);
          body.labels = unique([...current, ...(args.add_labels ?? [])])
            .filter((label) => !removed.has(label))
            .join(",");
        }
        if (Object.keys(body).length === 0) throw new InputError("Nothing to update: pass at least one field to change.");
        await client.updateString(stringId, body);
        return { string_id: stringId, sent: body, note: ASYNC_NOTE };
      }),
  );

  server.registerTool(
    "wti_set_translations",
    {
      title: "Set translations of a string",
      description:
        "Save the translation of one string in one or more locales (the source locale included). Each locale is saved " +
        "separately and the result says which ones failed, e.g. on WebTranslateIt validation errors.",
      inputSchema: {
        ...stringRef,
        translations: z.array(translationInput).min(1).max(100),
        minor_change: z
          .boolean()
          .optional()
          .describe("For source-locale edits such as typo fixes: don't flag the other locales as 'to verify'."),
        skip_validation: z
          .boolean()
          .optional()
          .describe("Save even if WebTranslateIt's checks (placeholders, length, …) fail."),
      },
      annotations: OVERWRITE,
    },
    async (args) =>
      run(async () => {
        await checkLocales(client, args.translations.map((translation) => translation.locale));
        const stringId = await resolveStringId(client, args);
        const results: { locale: string; saved: boolean; error?: string }[] = [];
        for (const translation of args.translations) {
          const body: Record<string, unknown> = { text: translation.text };
          if (translation.status) body.status = translation.status;
          if (args.minor_change) body.minor_change = "true";
          if (args.skip_validation) body.validation = "false";
          try {
            await client.saveTranslation(stringId, translation.locale, body);
            results.push({ locale: translation.locale, saved: true });
          } catch (error) {
            results.push({ locale: translation.locale, saved: false, error: (error as Error).message });
          }
        }
        if (results.every((result) => !result.saved)) {
          throw new Error(results.map((result) => `${result.locale}: ${result.error}`).join("\n"));
        }
        return { string_id: stringId, results };
      }),
  );

  if (!allowDelete) return;

  server.registerTool(
    "wti_delete_string",
    {
      title: "Delete a string",
      description: "Delete a string and all of its translations. This can't be undone; prefer status: obsolete.",
      inputSchema: stringRef,
      annotations: DELETE,
    },
    async (args) =>
      run(async () => {
        const stringId = await resolveStringId(client, args);
        await client.deleteString(stringId);
        return { deleted_string_id: stringId, note: ASYNC_NOTE };
      }),
  );
}
