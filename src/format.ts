import type { RawProject, RawStats, RawString, RawTranslation, TranslationText } from "./client.js";

/** Compact, model-friendly view of a string. Empty fields are dropped. */
export interface StringView {
  id: number;
  key: string;
  status?: string;
  type?: string;
  plural?: boolean;
  labels?: string[];
  category?: string;
  dev_comment?: string;
  file_id?: number;
  word_count?: number;
  created_at?: string;
  updated_at?: string;
  translations?: Record<string, { text: TranslationText; status?: string; updated_at?: string }>;
}

export function normalizeLabels(labels: unknown): string[] {
  if (Array.isArray(labels)) return labels.map((label) => String(label).trim()).filter(Boolean);
  if (typeof labels === "string") return labels.split(",").map((label) => label.trim()).filter(Boolean);
  return [];
}

export function compactString(raw: RawString): StringView {
  const view: StringView = { id: raw.id, key: raw.key };
  if (raw.status) view.status = raw.status;
  if (raw.type && raw.type.toLowerCase() !== "string") view.type = raw.type;
  if (raw.plural) view.plural = true;
  const labels = normalizeLabels(raw.labels);
  if (labels.length) view.labels = labels;
  const category = raw.category ?? (typeof raw.categories === "string" ? raw.categories : undefined);
  if (category) view.category = category;
  if (raw.dev_comment) view.dev_comment = raw.dev_comment;
  if (raw.file?.id) view.file_id = raw.file.id;
  if (typeof raw.word_count === "number") view.word_count = raw.word_count;
  if (raw.created_at) view.created_at = raw.created_at;
  if (raw.updated_at) view.updated_at = raw.updated_at;

  const translations = toTranslationList(raw.translations);
  if (translations.length) {
    view.translations = {};
    for (const translation of translations) {
      view.translations[translation.locale] = dropEmpty({
        text: translation.text ?? null,
        status: translation.status,
        updated_at: translation.updated_at,
      });
    }
  }
  return view;
}

function toTranslationList(value: RawString["translations"]): RawTranslation[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((translation): translation is RawTranslation => Boolean(translation?.locale));
}

export function compactProject(project: RawProject) {
  const files = project.project_files ?? [];
  const masters = files.filter((file) => !file.master_project_file_id);
  return {
    id: project.id,
    name: project.name,
    source_locale: project.source_locale?.code,
    target_locales: (project.target_locales ?? [])
      .map((locale) => locale.code)
      .filter((code) => code !== project.source_locale?.code),
    master_files: masters.map((master) => ({
      master_file_id: master.id,
      name: master.name,
      locale: master.locale_code,
      updated_at: master.updated_at,
      targets: files
        .filter((file) => file.master_project_file_id === master.id)
        .map((file) => dropEmpty({ locale: file.locale_code, file_id: file.id, name: file.name, updated_at: file.updated_at })),
    })),
  };
}

export function compactStats(stats: RawStats, onlyLocale?: string) {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [locale, raw] of Object.entries(stats ?? {})) {
    if (onlyLocale && locale !== onlyLocale) continue;
    if (!raw || typeof raw !== "object") continue;
    const count = num(raw.count_strings);
    const done = num(raw.count_strings_done);
    const toProofread = num(raw.count_strings_to_proofread);
    const notTranslatable = num(raw.count_strings_not_translatable);
    const translatable = count - notTranslatable;
    const percent = (part: number) => (translatable > 0 ? Math.round((part / translatable) * 1000) / 10 : undefined);
    result[locale] = dropEmpty({
      strings: count,
      done,
      to_translate: num(raw.count_strings_to_translate),
      to_verify: num(raw.count_strings_to_verify),
      to_proofread: toProofread,
      not_translatable: notTranslatable || undefined,
      // "done" only counts proofread strings; "translated" also counts those waiting for proofreading.
      percent_done: percent(done),
      percent_translated: percent(done + toProofread),
      words: num(raw.wc_count_strings) || undefined,
      stale: raw.stale === true ? true : undefined,
    });
  }
  return result;
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function dropEmpty<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== "")) as T;
}
