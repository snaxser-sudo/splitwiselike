# AGENTS.md

## Project Passport

SplitFair is a static Splitwise-style web app for small groups. It runs on
GitHub Pages with no frontend build step, and uses Supabase for Auth, Postgres,
RLS, and RPC-backed writes.

Primary audience: small groups sharing expenses for trips, flats, teams, and
dinners.

## Project Structure

- `index.html` loads the app, stylesheet, config, and ES module entrypoint.
- `styles.css` contains the full responsive UI styling.
- `src/config.js` stores public Supabase runtime config placeholders only.
- `src/app.js` contains Supabase setup, app state, data loading, rendering,
  event handlers, money/date helpers, and inline SVG icons.
- `supabase/schema.sql` owns database tables, indexes, triggers, RLS policies,
  and RPC functions.
- `.github/workflows/pages.yml` deploys the static files to GitHub Pages.

## Architecture Notes

- There is currently no bundler, package manager, or compile step.
- Supabase is imported in-browser from `https://esm.sh/@supabase/supabase-js@2`.
- Money is stored and calculated as integer cents.
- Group-scoped data access is enforced by Supabase RLS.
- Expense and settlement creation must go through RPC functions that validate
  membership and totals.
- UI code should render already-loaded state. Do not move data merging or status
  decisions into individual views.
- Keep changes inside the existing static app shape unless the user explicitly
  approves a larger architecture change.

## Common Commands

- Run locally: `python3 -m http.server 4173`
- Open locally: `http://localhost:4173/`
- Search code: `rg "term"` or `rg --files`
- Check git state: `git status --short`

## Codex Workflow

- Read this file, `README.md`, and `.codex/SNAPSHOT.md` before substantial work.
- Use `.codex/rules/` as supporting project rules when relevant.
- Prefer small, targeted patches.
- Do not create Claude-specific files for Codex setup unless the user asks.
- Do not update `.codex/SNAPSHOT.md` as memory unless the user explicitly asks
  for a snapshot update or approves one.

## Mandatory Rules

Follow these rules strictly when working in this repository.

1. No changes without explicit approval.
   Always propose changes first and wait for confirmation before modifying any code. Exception: small, unambiguous tasks, such as fixing a typo, may be done directly when intent and scope are obvious.

2. Think beyond the scope of the change.
   Do not fix symptoms only. Before proposing a modification, consider the architecture, affected areas, existing patterns, and whether the change addresses the root cause.

3. Follow architecture.
   All new code must follow the established project structure and service layer pattern. Do not introduce new architectural patterns, layers, or organizational structures. Work within what already exists.

4. Keep data and UI strictly separated.
   The data layer must produce one final, merged state per entity, combining every relevant source into a single consistent answer. The UI consumes that pre-merged state and only shapes it for layout. UI must never pick sources, merge data, or decide status such as "today", "not today", "imminent", or similar. Per-view merge logic in the data layer is also forbidden. Two screens showing the same entity must get the same merged answer from the same place. If merging happens per-view, that is the bug; fix the data layer before UI work.

5. Check for duplicates.
   Before adding any new method, function, endpoint, or class, search for existing implementations first. Use `rg` or another search tool to find similar names. If similar code exists, modify it instead of adding duplicates.

6. Follow existing patterns.
   Before writing new code, search for similar patterns in the codebase. Match existing conventions for error handling, logging, naming, and response structure. Do not introduce personal preferred style when the project already has a pattern.

7. Check what the API provides first.
   Before building workarounds, fallbacks, or synthetic data, verify what the API endpoints already offer. Fetch a real response, inspect the fields, and look for undocumented endpoints. Do not reinvent what the API already provides.

8. Do not push or create PRs without asking first.
   Always get explicit approval before pushing to a remote or creating a pull request.

9. Never use destructive git commands to undo own edits.
   Do not use `git checkout`, `git restore`, or `git reset` to undo your own edits. These commands can destroy user work. Use targeted edits to revert only the specific changes you made.

10. No AI attributions in commits.
    Never add Claude, AI, assistant, or code generation attribution in git commit messages.

11. Do not install packages without explicit approval.
    Before installing anything, verify the package is safe and widely used, then ask for approval.

12. Test parsers against real API responses.
    Every external API parser needs a golden test that feeds it a real captured response checked into `test/fixtures/`. This applies to JSON, XML, protobuf, CSV, scraped HTML, or any other format. Fixtures must be captured verbatim from the live source. Fake API clients are fine for orchestration tests, but never substitute for parser goldens. Do not fabricate fixtures.

13. Respond simply and briefly.
    Keep responses very simple and short. Do not add many technical details unless the user asks for them.

14. Do not write to memory without explicit approval.
    Never create or update entries under an auto-memory directory or `MEMORY.md` index unilaterally. Only write memory when the user initiates it or explicitly approves a proposed memory write. Apply one-off feedback in the current conversation only.
