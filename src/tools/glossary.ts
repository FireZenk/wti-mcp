import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dropEmpty } from "../format.js";
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
  mapLimit,
  run,
  type ToolContext,
} from "./common.js";

const TERM_STATUSES = ["proposed", "approved", "refused"] as const;
/** 20 pages of 250 terms. */
const MAX_TERM_PAGES = 20;

const termStatus = () =>
  z.enum(TERM_STATUSES).optional().describe("proposed (default), approved or refused.");

/** Term translation statuses are written as names but read back as numbers. */
const TERM_STATUS_NAMES: Record<string, string> = { "1": "approved", "0": "proposed", "-1": "refused" };

export function termStatusName(status: unknown): unknown {
  return TERM_STATUS_NAMES[String(status)] ?? status;
}

const STATUS_NOT_UPDATABLE =
  "Text and description were updated, but not the status: WebTranslateIt's API can't change the status of an " +
  "existing glossary translation (it fails or ignores it). Change it in the WebTranslateIt web interface.";

export function registerGlossaryTools(server: McpServer, { client, readOnly, allowDelete }: ToolContext): void {
  server.registerTool(
    "wti_search_glossary",
    {
      title: "Search the glossary",
      description:
        "Search the project's glossary (term base) for a word, case-insensitively in the term and its description, " +
        "and optionally show how each match is translated in a locale. Use it to keep wording consistent.",
      inputSchema: {
        query: z.string().optional().describe("Text to look for. Omit to list terms."),
        locale: locale().optional().describe("Also return each match's translations in this locale."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of terms to return (default 25)."),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        if (args.locale) await checkLocales(client, [args.locale]);
        const { items, nextPage } = await client.listTerms(MAX_TERM_PAGES);
        const needle = args.query?.trim().toLowerCase();
        const matches = needle
          ? items.filter(
              (term) =>
                term.text?.toLowerCase().includes(needle) || term.description?.toLowerCase().includes(needle),
            )
          : items;
        const shown = matches.slice(0, args.limit ?? 25);
        const terms = await mapLimit(shown, 5, async (term) => {
          const view: Record<string, unknown> = dropEmpty({ id: term.id, text: term.text, description: term.description ?? undefined });
          if (args.locale) {
            const translations = await client.getTermTranslations(term.id, args.locale);
            view.translations = translations.map((translation) =>
              dropEmpty({
                id: translation.id,
                text: translation.text,
                status: termStatusName(translation.status),
                description: translation.description ?? undefined,
              }),
            );
          }
          return view;
        });
        return dropEmpty({
          matches: matches.length,
          terms,
          note:
            nextPage !== null
              ? `Only the first ${items.length} terms of the glossary were searched.`
              : undefined,
        });
      }),
  );

  if (readOnly) return;

  server.registerTool(
    "wti_create_term",
    {
      title: "Add a glossary term",
      description: "Add a term to the glossary, optionally with its translations.",
      inputSchema: {
        text: z.string().trim().min(1).describe("The term in the source locale."),
        description: z.string().optional().describe("What the term means or how to use it."),
        translations: z
          .array(
            z.object({
              locale: locale(),
              text: z.string().min(1),
              description: z.string().optional(),
              status: termStatus(),
            }),
          )
          .optional(),
      },
      annotations: WRITE,
    },
    async (args) =>
      run(async () => {
        await checkLocales(client, (args.translations ?? []).map((translation) => translation.locale));
        const body = dropEmpty({
          text: args.text,
          description: args.description,
          translations: args.translations?.map((translation) => dropEmpty({ ...translation })),
        });
        const created = await client.createTerm(body);
        return { created: created ?? { text: args.text } };
      }),
  );

  server.registerTool(
    "wti_update_term",
    {
      title: "Update a glossary term",
      description: "Change a glossary term's text or description.",
      inputSchema: {
        term_id: id("Term id from wti_search_glossary."),
        text: z.string().trim().min(1).optional(),
        description: z.string().optional(),
      },
      annotations: OVERWRITE,
    },
    async (args) =>
      run(async () => {
        const body = dropEmpty({ text: args.text, description: args.description });
        if (Object.keys(body).length === 0) throw new InputError("Nothing to update: pass text or description.");
        await client.updateTerm(args.term_id, body);
        return { term_id: args.term_id, sent: body, note: ASYNC_NOTE };
      }),
  );

  server.registerTool(
    "wti_set_term_translation",
    {
      title: "Set a glossary term translation",
      description:
        "Create or update the translation of a glossary term in one locale. Updates the existing translation when " +
        "the term has exactly one in that locale; pass translation_id when it has several. The status can only be " +
        "set when the translation is created.",
      inputSchema: {
        term_id: id("Term id from wti_search_glossary."),
        locale: locale(),
        text: z.string().min(1),
        description: z.string().optional(),
        status: termStatus().describe(
          "proposed (default), approved or refused. Only applied when creating: WebTranslateIt's API can't change " +
            "the status of an existing translation.",
        ),
        translation_id: id("Translation to update, when the term has several in this locale.").optional(),
      },
      annotations: OVERWRITE,
    },
    async (args) =>
      run(async () => {
        await checkLocales(client, [args.locale]);
        let translationId = args.translation_id;
        if (!translationId) {
          const existing = await client.getTermTranslations(args.term_id, args.locale);
          if (existing.length > 1) {
            const options = existing.map((translation) => `${translation.id} ("${translation.text}")`).join(", ");
            throw new InputError(`Term ${args.term_id} has several ${args.locale} translations: ${options}. Pass translation_id.`);
          }
          translationId = existing[0]?.id;
        }
        if (translationId) {
          // Sending a status here makes WTI answer 500 (as a name) or ignore it (as a number).
          const body = dropEmpty({ text: args.text, description: args.description });
          await client.updateTermTranslation(args.term_id, args.locale, translationId, body);
          return dropEmpty({
            term_id: args.term_id,
            locale: args.locale,
            updated_translation_id: translationId,
            note: args.status ? STATUS_NOT_UPDATABLE : undefined,
          });
        }
        const body = dropEmpty({ text: args.text, description: args.description, status: args.status });
        await client.createTermTranslation(args.term_id, args.locale, body);
        return { term_id: args.term_id, locale: args.locale, created: true };
      }),
  );

  if (!allowDelete) return;

  server.registerTool(
    "wti_delete_term",
    {
      title: "Delete a glossary term",
      description: "Delete a glossary term and all its translations. This can't be undone.",
      inputSchema: { term_id: id("Term id from wti_search_glossary.") },
      annotations: DELETE,
    },
    async (args) =>
      run(async () => {
        await client.deleteTerm(args.term_id);
        return { deleted_term_id: args.term_id };
      }),
  );
}
