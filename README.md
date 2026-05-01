# SplitFair

Static Splitwise-style web app for GitHub Pages with Supabase Auth, Postgres,
RLS, and RPC-backed writes.

## What Is Included

- Email magic-link sign-in.
- Groups with invite links.
- Shared expenses with equal or manual splits.
- Simplified "who pays whom" balances.
- Recorded settlements.
- Supabase Row Level Security for group-scoped data access.
- Zero frontend build step: it runs as plain static files.

## Supabase Setup

1. Create a Supabase project.
2. Open `SQL Editor` and run [`supabase/schema.sql`](./supabase/schema.sql).
3. Go to `Authentication` -> `URL Configuration`.
4. Set `Site URL` to your GitHub Pages URL, for example:

   ```text
   https://YOUR_GITHUB_USER.github.io/YOUR_REPO/
   ```

5. Add redirect URLs:

   ```text
   https://YOUR_GITHUB_USER.github.io/YOUR_REPO/
   http://localhost:4173/
   ```

6. Go to `Project Settings` -> `API Keys`.
7. Copy the project URL and the publishable key.
8. Put them into [`src/config.js`](./src/config.js):

   ```js
   window.SPLITFAIR_CONFIG = {
     supabaseUrl: "https://YOUR_PROJECT.supabase.co",
     supabasePublishableKey: "sb_publishable_...",
   };
   ```

The publishable key is safe to expose in a browser app when RLS is enabled.
Never put a secret key or service role key into this repo.

## Run Locally

```bash
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173/
```

## Deploy To GitHub Pages

1. Create a GitHub repo and push this folder to the `main` branch.
2. In GitHub, open `Settings` -> `Pages`.
3. Select `GitHub Actions` as the source.
4. Push to `main`; the workflow in [`.github/workflows/pages.yml`](./.github/workflows/pages.yml)
   will publish the app.

## Notes

- Money is stored as integer cents, not floating-point numbers.
- Direct expense/payment writes are blocked by RLS; the app writes through
  Supabase RPC functions that validate membership and split totals.
- GitHub Pages hosts only the static app. Supabase owns Auth, database, and
  authorization.
