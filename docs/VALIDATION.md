# Validation — 23 September 2026

Passed:
- Next.js production build (JavaScript application; no TypeScript source).
- Six root test cases: credential encryption/tampering, session/inbound signatures, validation, all eight adapter request shapes, rejection classification, and PostgreSQL quota/idempotency/deduplication behavior.
- The database case executes the schema/functions in PGlite and checks cap enforcement, duplicate requests, capacity release exactly once, uncertain sends, period boundaries, month-end billing anniversaries, disabled connections and duplicate incoming records.
- Three Worker tests: MIME parsing and signed delivery with stable retry IDs, explicit rejection after failed saves, and domain/size rejection.
- Cloudflare Wrangler dry-run bundle.
- Browser smoke check with fixture data: navigation, persona access to every compatible provider, mobile overflow and login redirect. Desktop/mobile screenshots were visually inspected. No fixture connections are seeded into the delivered app.

Not tested against live accounts:
- Provider approval, API key permissions, actual delivery or recipient-client threading.
- Your DNS, Neon instance, Vercel deployment or Cloudflare routing configuration.
- Real delivery webhooks. Handlers implement documented verification but require live round-trip testing with your signing keys.

No real email was sent. Begin with controlled recipient accounts, following README.md.
