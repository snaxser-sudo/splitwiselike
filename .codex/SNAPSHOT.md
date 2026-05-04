# SplitFair Snapshot

Updated: 2026-05-01

## Current State

SplitFair is a plain static web app for shared expenses. It has no build step:
`index.html` loads `styles.css`, `src/config.js`, and `src/app.js` directly.
Supabase provides Auth, Postgres, RLS, and RPC functions.

## Important Files

- `AGENTS.md`: primary Codex instructions and mandatory project rules.
- `README.md`: setup, local run, and deploy instructions.
- `src/app.js`: all current frontend behavior.
- `supabase/schema.sql`: database schema, policies, triggers, and RPCs.
- `.github/workflows/pages.yml`: GitHub Pages deployment.

## Run

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173/`.

## Constraints

- Do not install packages without approval.
- Do not push, create PRs, or commit without approval.
- Do not store Supabase secret or service-role keys in the repo.
- Keep data merging centralized before UI rendering.
- Use real API responses for parser fixtures if external parsers are added.

## Next Useful Improvements

- Consider extracting data/state helpers from `src/app.js` if the app grows.
- Add focused tests if money, split, or debt logic is refactored.
- Keep README and this snapshot aligned when workflow changes are approved.
