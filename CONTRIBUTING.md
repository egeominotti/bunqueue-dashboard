# Contributing

Thanks for your interest in **bunqueue dashboard**. This guide gets you from
clone to a green pull request.

## Getting started

```bash
bun install
bun start          # control agent + dashboard together (Ctrl-C stops both)
```

`bun start` runs the control agent (`http://127.0.0.1:6800`) and the dashboard
(`http://localhost:5273`, `/api` proxied to `:6790`). Full docs live at
<https://egeominotti.github.io/bunqueue-dashboard/docs/>.

## The quality gate (must be green)

```bash
bun run build      # tsc --noEmit + vite build
bun run check      # biome lint + format
bun test           # unit + agent-lifecycle tests
```

CI runs exactly this on every push and pull request. Please run it locally
before opening a PR.

## Ground rules

- **Additive first.** Prefer new files plus minimal glue over rewriting working
  code. The project keeps two API clients on purpose: `src/lib/api.ts` (the
  original, classic pages) and `src/lib/bq.ts` (the complete, shape-verified
  client for all new work). See `CLAUDE.md` for the full architecture notes.
- **Keep `src/` passing the strict Biome ruleset.** Don't silence a rule to
  dodge a real fix.
- **Update `CHANGELOG.md`** under `## [Unreleased]` and **bump the
  `package.json` `version`** for anything that ships. The release workflow tags
  and publishes `v<version>` from `package.json`.
- Conventional-style commit subjects are appreciated (`feat:`, `fix:`, `docs:`,
  `chore:`).

## Pull requests

Fill in the PR template, keep the diff focused on one thing, and make sure the
gate is green. Screenshots or a short clip help a lot for UI changes.

## Reporting bugs and requesting features

Use the issue templates (bug report / feature request). For **security**
issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

By contributing you agree that your contributions are licensed under the
project's [MIT license](LICENSE), and you are expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
