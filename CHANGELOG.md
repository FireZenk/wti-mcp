# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Node.js 22 or newer is required: Node.js 20 reached end of life in April 2026.
- CI runs on Node.js 22 and 24 with `actions/checkout` and `actions/setup-node` v7.

## [0.1.0] - 2026-11-11

First release.

### Added

- Read tools: `wti_get_project`, `wti_get_stats`, `wti_list_strings`, `wti_get_string`, `wti_download_file`,
  `wti_search_glossary`.
- Write tools: `wti_create_string`, `wti_update_string`, `wti_set_translations`, `wti_upload_file`,
  `wti_add_locale`, `wti_create_term`, `wti_update_term`, `wti_set_term_translation`.
- Delete tools, only with `WTI_ALLOW_DELETE=true`: `wti_delete_string`, `wti_delete_term`, `wti_remove_locale`.
- Configuration from environment variables or an existing `.wti` file; read-only mode, automatic for
  read-only tokens.
- Locale codes are checked against the project, with suggestions (`de` → `de-DE`).
- Retries on rate limiting (429, honouring `Retry-After`) and, for GET requests, on timeouts and 502/504.
