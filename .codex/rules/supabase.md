# Supabase Rule

- Treat `supabase/schema.sql` as the source of truth for tables, RLS policies,
  triggers, and RPC functions.
- Keep browser config limited to Supabase URL and publishable key.
- Never add service-role keys or secrets to frontend files.
- Verify what Supabase already returns before creating workarounds or synthetic
  data.
- Keep expense and settlement creation behind RPC validation.
- Preserve integer-cent money calculations.
- If adding external API parsers, capture real responses into fixtures and test
  parsers against those fixtures.
