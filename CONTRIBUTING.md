# Contributing

Thanks for helping. Bug reports, fixes and new tools are welcome.

## Getting started

```bash
git clone <your fork>
cd wti-mcp
npm install      # also builds dist/
npm test
```

## Before opening a pull request

- `npm run typecheck` and `npm test` pass.
- New behaviour has a test. `test/fake-wti.ts` is a scripted stand-in for the WebTranslateIt API, so tests never
  call the real service; `test/server.test.ts` shows how to drive the tools through an MCP client.
- Tool descriptions say what the tool does in one or two sentences, and parameter descriptions give an example.
  They are what the model reads to decide which tool to call.
- If you found a WebTranslateIt API behaviour that differs from its documentation, add it to "Things worth
  knowing" in the README.
- Add a line to `CHANGELOG.md` under an "Unreleased" heading.

## Testing against a real project

Use a project you can afford to change, or throwaway keys you delete afterwards, and start with
`WTI_READ_ONLY=true`. Never commit tokens: `.wti` and `.env` are git-ignored.

## Reporting security issues

Please don't open a public issue for anything that could expose tokens or let a tool reach beyond the configured
project. Use GitHub's "Report a vulnerability" (Security tab) instead.
