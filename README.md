# wti-mcp

[![CI](https://github.com/FireZenk/wti-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/FireZenk/wti-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server for [WebTranslateIt](https://webtranslateit.com). It lets an
AI assistant look up keys and their translations, find what's left to translate, create and edit strings, save
translations, check progress, use the glossary, and push or pull language files — the things you'd otherwise do
with the [`wti`](https://github.com/webtranslateit/webtranslateit) CLI or the web UI.

It talks to the WebTranslateIt REST API the same way `wti` 3.x does: a Bearer token and
`/api/projects/current` (or `/api/projects/<id>` for organization tokens).

> This is an independent project, not made or endorsed by WebTranslateIt.

## What you can ask

- "Which keys are still untranslated in de-DE? Draft translations for them, matching the glossary."
- "Show me `booking_confirm_title` in every language."
- "Add the key `rebook_card_title` with the text 'Book again', label it `release-5.31`, and translate it into
  French and Spanish."
- "How far along is each locale? Which ones are below 90% translated?"
- "Find every key starting with `checkout_` that has no developer comment."

## Tools

| Tool | What it does | Mode |
| --- | --- | --- |
| `wti_get_project` | Source/target locales and master files with their ids | read |
| `wti_get_stats` | Progress per locale: done, to translate, to verify, to proofread, % done and % translated | read |
| `wti_list_strings` | List or search strings by key (exact or regex), label, file, status, date; with translations | read |
| `wti_get_string` | One string by key or id, with its translation in every locale | read |
| `wti_download_file` | Download a language file for a locale (one-file `wti pull`) | read |
| `wti_search_glossary` | Search the term base, optionally with translations in a locale | read |
| `wti_create_string` | Create a key with its source text, translations, comment and labels | write |
| `wti_update_string` | Rename a key, change its comment, labels (add/remove) or status | write |
| `wti_set_translations` | Save a string's translation in one or more locales | write |
| `wti_upload_file` | Compare a local language file with WebTranslateIt's copy, then upload it (one-file `wti push`) | write |
| `wti_add_locale` | Add a target locale | write |
| `wti_create_term`, `wti_update_term`, `wti_set_term_translation` | Edit the glossary | write |
| `wti_delete_string`, `wti_delete_term`, `wti_remove_locale` | Delete things | delete |

Write tools aren't registered in read-only mode. Delete tools are only registered with `WTI_ALLOW_DELETE=true`.

## Setup

Requires Node.js 22 or newer.

```bash
git clone https://github.com/FireZenk/wti-mcp.git
cd wti-mcp
npm install   # also builds dist/
```

The server is then `node /path/to/wti-mcp/dist/index.js`.

### Configuration

| Variable | Meaning |
| --- | --- |
| `WTI_API_TOKEN` | API token (`wti_pw_…`, `wti_iw_…`, …) or legacy project API key. |
| `WTI_PROJECT_API_KEY` | Same, under the name the `wti` gem uses. |
| `WTI_CONFIG_FILE` | Path to a `.wti` file to read `api_key` and `project_id` from, so an existing `wti` setup works as is. `<%= ENV['NAME'] %>` is expanded. |
| `WTI_PROJECT_ID` | Numeric project id. Needed for organization tokens only. |
| `WTI_READ_ONLY` | `true` to expose read tools only. Automatic for read-only tokens (`wti_pr_…`, `wti_ir_…`). |
| `WTI_ALLOW_DELETE` | `true` to also expose the delete tools. |
| `WTI_BASE_URL` | Defaults to `https://webtranslateit.com`. Must be https (localhost excepted, for testing). |

Environment variables win over the `.wti` file.

### Claude Code

Reusing the `.wti` of a project:

```bash
claude mcp add wti -e WTI_CONFIG_FILE=/path/to/your/app/.wti -- node /path/to/wti-mcp/dist/index.js
```

Or with a token:

```bash
claude mcp add wti -e WTI_API_TOKEN=wti_pw_… -- node /path/to/wti-mcp/dist/index.js
```

Add `-e WTI_READ_ONLY=true` for a read-only setup. Each server instance works on one project: add one per project
(e.g. `wti-android`, `wti-ios`) if you have several.

### Claude Desktop and other MCP clients

```json
{
  "mcpServers": {
    "wti": {
      "command": "node",
      "args": ["/path/to/wti-mcp/dist/index.js"],
      "env": { "WTI_CONFIG_FILE": "/path/to/your/app/.wti" }
    }
  }
}
```

## Things worth knowing

- **Locale codes are the project's own**: `de-DE`, not `de`, if that's how the project is set up. Tools check the
  code against the project and suggest the right one.
- **Keys are unique per file.** `wti_get_string` and friends accept a key and find its id; pass `file_id` when the
  same key exists in several files. The API's key filter matches prefixes, so the server picks the exact match.
- **Writes are asynchronous.** WebTranslateIt answers 202 Accepted and applies changes in the background; re-read
  after a few seconds before relying on them.
- **`wti_upload_file` checks WebTranslateIt before uploading.** Neither `wti push` nor the API looks at what
  changed on WebTranslateIt since your last pull. Called without `confirm`, the tool uploads nothing: it downloads
  the current copy and lists the lines that are only there (someone else's changes, which the upload could
  overwrite) and the lines only in your file. The upload happens on a second call with the `confirm` token from
  that preview. The token is tied to both files' content, so if either changes in between you get a new preview
  instead of an upload. The comparison ignores line order, indentation and blank lines; it works best on files
  that came from a `wti pull`, since WebTranslateIt's export formatting may differ from a hand-written file.
- **`wti_upload_file` keeps missing strings by default** (`ignore_missing: true`), unlike the API, so uploading a
  partial file can't mark the rest of the project obsolete. Pass `ignore_missing: false` to sync deletions.
  With `merge: false` (the default) your file's text replaces WebTranslateIt's where they differ; with
  `merge: true` WebTranslateIt keeps its text and only adds what it doesn't have.
- **Statuses.** Translations: `status_unproofread`, `status_proofread`, `status_unverified`. Strings: `current`,
  `hidden`, `obsolete`. In stats, `done` only counts proofread strings; `percent_translated` also counts the ones
  waiting for proofreading.
- **Glossary translation statuses can only be set on creation.** WebTranslateIt's API answers 500 to a status
  name on update and silently ignores a numeric one, so `wti_set_term_translation` only updates the text and
  description of an existing translation and says so. Statuses read back as numbers (1, 0, -1); the server shows
  them as `approved`, `proposed`, `refused`.
- **WebTranslateIt doesn't reject a translation that drops a placeholder** (e.g. `%1$s`) when saved through the API,
  so check placeholders yourself.
- **Rate limits.** The API allows 25 requests per second per IP. The client retries 429 responses (honouring
  `Retry-After`) and, for GET requests only, timeouts and 502/504.
- **The token only goes to the WebTranslateIt host.** Pagination links pointing elsewhere are refused.

## Development

```bash
npm test          # unit and MCP-level tests against a fake WebTranslateIt
npm run typecheck
npm run inspect   # open the server in the MCP Inspector (needs a token in the environment)
```

The code: `src/client.ts` (HTTP client), `src/config.ts` (environment and `.wti`), `src/format.ts` (compact
responses for the model), `src/tools/*` (tool definitions), `src/server.ts` and `src/index.ts` (stdio entry
point). See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

The server runs locally and only talks to WebTranslateIt with the token you give it. Texts coming back from
WebTranslateIt (translations, comments, glossary entries) are written by people and reach the model as data;
keep write access for setups where you review what the assistant does, and use `WTI_READ_ONLY=true` otherwise.
To report a vulnerability, use GitHub's "Report a vulnerability" in the Security tab rather than a public issue.

## License

[MIT](LICENSE)
