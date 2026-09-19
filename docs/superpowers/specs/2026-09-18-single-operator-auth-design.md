# Single-operator auth for self-hosted mcp-telegram-cloud

Status: draft
Date: 2026-09-18
Fork: https://github.com/Gi99lin/mcp-telegram-cloud (upstream: https://github.com/mcp-telegram/mcp-telegram-cloud)
Deployment target: self-hosted at `mcp-tg.gigglin.tech`, backing Claude Code's `telegram-hosted` MCP connector, replacing the public `mcp.mcp-telegram.com` hosted instance.

## Goal

Upstream `mcp-telegram-cloud` is built as a public multi-tenant service: anyone
can register an OAuth client and complete their own Telegram QR login, with no
admin allowlist. For a private, single-operator deployment this is unwanted —
even though a stranger could only ever reach their own Telegram data, they'd
still be consuming this server's compute/liability for free, which the
operator explicitly doesn't want.

This deployment needs to be reachable by exactly one person, from multiple
MCP clients (Claude Code, potentially ChatGPT later), without a static IP
(rules out an IP allowlist) and without weakening security via a bare
proxy-level Basic Auth prompt in front of the OAuth dance.

## Non-goals

- **Multi-account support** — already implemented upstream (`src/tools/accounts.ts`,
  v2.32.0): `telegram-accounts-list/-add/-remove/-switch`. Zero changes needed.
- **Outbound proxy support** — SOCKS5/SOCKS4/MTProxy already implemented in the
  underlying `@overpod/mcp-telegram` library (`telegram-client.ts:resolveProxy`),
  driven entirely by env vars (`TELEGRAM_PROXY_IP/PORT/SOCKS_TYPE/USERNAME/PASSWORD`
  or `TELEGRAM_PROXY_SECRET`). Confirmed SOCKS5 is sufficient for this
  deployment — plain HTTP CONNECT-proxy is not supported by the underlying
  GramJS protocol library and is out of scope (would require patching a
  different upstream repo, `mcp-telegram/mcp-telegram`).
- Rewriting the landing/privacy/terms copy for a public audience — this
  deployment isn't publicly marketed; those routes get gated behind the admin
  session (see below) rather than rewritten.

## Approach

Reuse the existing OAuth token machinery (`src/oauth.ts`, `src/routes/oauth.tsx`)
almost entirely unchanged — client registration (RFC 7591), token issuance,
refresh-token rotation, and `/mcp` bearer validation are all already
implemented and hardened. Rebuilding a parallel bespoke API-key system would
duplicate that work and its edge cases for no benefit.

The only change: what `/oauth/authorize` requires before issuing a grant.

- **Today:** authorize → Telegram QR login → the resulting Telegram identity
  becomes `owner_user_id` → token issued.
- **New:** authorize → check for a valid admin session cookie.
  - Cookie present and valid → token issued immediately, no prompt, using a
    **fixed** `OWNER_USER_ID` constant for this whole deployment (derived from
    `ADMIN_USERNAME`).
  - No cookie → serve an admin login form (username + password, checked
    against `ADMIN_PASSWORD_HASH`) → on success, set the cookie, then issue
    the token.
- **First-run bootstrap:** if `OWNER_USER_ID` has no primary Telegram session
  yet (fresh deploy), admin login is followed once by the existing QR-login
  screen to establish it. Every later authorize (new client, new device) only
  needs the admin cookie/login — no more QR scans.

This means Claude.ai/ChatGPT-style clients see a completely standard OAuth
flow (dynamic registration stays open — harmless, since it grants nothing by
itself) — only the human-interactive step behind `/authorize` changes from
"prove you own a Telegram account" to "prove you're the operator."

### Alternatives considered

- **IP allowlist at the reverse proxy** — rejected: no static IP available.
- **Plain HTTP Basic Auth at the reverse proxy** — rejected: prompts on every
  request from any network, would need to also survive the browser-based
  QR-login step, and doesn't give per-credential revocation.
- **Bespoke separate API-key system bypassing OAuth** — rejected: OAuth
  machinery already exists, is tested, and Claude.ai/ChatGPT already expect
  to speak standard OAuth; reinventing it duplicates token rotation, replay
  protection, and revocation logic that already works.

## Components touched

- `src/config.ts` — add `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, derive
  `OWNER_USER_ID` from `ADMIN_USERNAME`.
- New `src/auth/admin.ts` — password verification (argon2, via a small
  generator script under `scripts/`), signed session-cookie issuance/
  validation (reusing HMAC helpers already in `src/crypto.ts`).
- `src/routes/oauth.tsx` (`/authorize` handler) — swap the QR-login identity
  gate for the admin-cookie/login gate; keep first-run QR bootstrap.
- `src/routes/oauth.tsx` (`/revoke` handler) — **behavior fix**, see below.
- `src/routes/login.tsx` — becomes the admin login form instead of "log in
  with your Telegram account."
- Admin panel (existing `src/routes/admin.tsx` / `/api` admin routes) — add
  an explicit "Disconnect Telegram account" action.
- `src/server.tsx` — gate or drop the public landing/privacy/terms routes
  behind the admin session, per upstream's own self-hosting guidance for
  non-public deployments.

## Revoke-semantics fix (found during design review)

Today, `POST /oauth/revoke` calls `sessions.destroyUserSession(userId)` (full
Telegram logout) **and** `oauth.revokeAllUserTokens(userId)` (every client's
tokens, not just the caller's) — see `src/routes/oauth.tsx:341-356`. That's
correct in the original one-owner-per-Telegram-identity model, where
disconnecting means "I'm done with this service." Under a fixed shared
`OWNER_USER_ID`, it becomes dangerous: if ChatGPT's client calls `/revoke`,
it would silently log out Claude.ai's tokens too and tear down the shared
Telegram session.

Fix: split into two independent actions.
- **Token revoke** (`/oauth/revoke`, unchanged trigger): revokes only the
  calling client's own access + refresh tokens. No longer touches other
  clients' tokens or the Telegram session.
- **Telegram disconnect** (new, explicit, admin-panel-only): calls
  `destroyUserSession`. Only this tears down the actual Telegram login.

## Data model

No new tables. `OWNER_USER_ID` is a fixed constant (e.g. `admin:<username>`)
instead of a QR-derived Telegram id — this is a fresh deployment with no
existing rows, so no migration is needed. `ADMIN_USERNAME` and
`ADMIN_PASSWORD_HASH` live in `.env`, same pattern as the existing
`ADMIN_TOKEN`.

## Admin session cookie

`httpOnly`, `Secure`, `SameSite=Lax`, HMAC-signed, sliding 30-day expiry.
Entirely separate from OAuth tokens — it only gates the `/authorize`
login prompt and the admin panel, nothing else.

## Deployment

- **Local:** `docker compose up -d --build` against the vendored Dockerfile,
  for development/testing only.
- **Production (server):** never build on the server. A GitHub Actions
  workflow (`.github/workflows/docker-publish.yml`, mirroring the existing
  pattern in `manager-helper`) builds on push to `main` and pushes to
  `ghcr.io/gi99lin/mcp-telegram-cloud:latest`. The `My_server` repo's
  `mcp-telegram/docker-compose.yml` pulls that image (Watchtower-labelled,
  like `manager-helper`) instead of building from source — no vendored
  source clone needed on the server.

## Testing plan

- Unauthenticated `GET /oauth/authorize` redirects to admin login — never
  silently succeeds.
- Wrong admin password rejected and rate-limited.
- Correct password sets the cookie and completes the grant.
- A second client's `/authorize` with an existing valid cookie skips the
  login prompt entirely and issues a token immediately.
- Revoking one client's token leaves a second client's token, and the
  Telegram session, intact (regression test for the revoke-semantics fix).
- Explicit "Disconnect Telegram" action actually logs out and clears
  `user_sessions`/`telegram_accounts`/`active_account` for `OWNER_USER_ID`.
- First-run bootstrap reaches the QR screen exactly once, not on every
  subsequent authorize.
- Existing multi-account tools (`telegram-accounts-*`) still work unchanged
  against the fixed `OWNER_USER_ID`.
- SOCKS5 proxy env vars (manual/local verification, not CI): connecting via
  a configured `TELEGRAM_PROXY_*` set reaches Telegram through the proxy.
