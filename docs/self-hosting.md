# Self-Hosting Guide

This guide covers running `mcp-telegram-cloud` on your own infrastructure.
If you only want to try the hosted service, skip this — go to
[mcp-telegram.com](https://mcp-telegram.com).

## Who should self-host

- You don't trust a third party with your Telegram session.
- You run a private community and need the service inside a trusted
  network.
- You want to modify or extend the server.

## Who should **not** self-host

- You want a casual, zero-ops setup — use the hosted service.
- You cannot commit to running security updates promptly. A stale
  deployment with live MTProto sessions is a liability.

## Threat model — read this first

The SQLite database stores **live Telegram MTProto session strings in
plain text**. Anyone with read access to the database file can clone each
user's Telegram account without their knowledge. There is **no
application-level encryption** of sessions at rest.

Mitigations must live outside the application:

- Full-disk encryption on the host (LUKS, FileVault, APFS encrypted
  volume).
- Strict filesystem permissions on the DB file and volume (`0600`).
- Encrypted backups. Never push plaintext DB dumps to object storage.
- Host hardening: minimal attack surface, SSH keys only, firewall.
- No shared access. Every root user on the host is effectively a
  Telegram-session admin.

If you can't guarantee the above for every environment the DB touches
(including backups), do not self-host.

## Requirements

- Docker 24+ and Docker Compose, **or** Node.js 22+ and pnpm 10+.
- A public HTTPS endpoint — OAuth clients (Claude.ai, ChatGPT) will not
  talk to a plaintext HTTP service.
- Telegram API credentials from <https://my.telegram.org/apps>.
- A domain you control. Used for OAuth issuer URLs — changing `ISSUER`
  later invalidates all issued access + refresh tokens, all registered
  OAuth clients (RFC 7591), and forces every connected Claude.ai /
  ChatGPT user to re-authorize and rescan their QR code. Pick once.

## Required environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `TELEGRAM_API_ID` | ✅ | Numeric ID from my.telegram.org. |
| `TELEGRAM_API_HASH` | ✅ | Hex hash from my.telegram.org. |
| `ISSUER` | ✅ | Public HTTPS URL, no trailing slash. |
| `ADMIN_TOKEN` | ⚠️ | 32-byte hex. Optional but strongly recommended for any public deployment — without it the admin-only `/api/stats` and `/api/import-session` (operator path) return `401`. See `.env.example` for generator. |

All other vars are optional with safe defaults — see
[`.env.example`](../.env.example) for the full list.

## Hardening checklist

### 1. Generate strong secrets

```bash
# ADMIN_TOKEN and LOG_HASH_SALT
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store them in your secrets manager (GitHub Secrets, Docker secrets,
Vault, 1Password, etc.) — **never** commit them. The pre-commit
`gitleaks` hook will catch obvious leaks but is not a substitute for
discipline.

### 2. Hash user IDs in logs

```env
LOG_USER_IDS=false
LOG_HASH_SALT=<your-32-byte-hex>
```

Telegram user IDs are numeric and have a small enough space that
unsalted hashes can be brute-forced. The HMAC salt closes that gap.
Rotating the salt breaks correlation across log epochs — do this once
per incident, not as a routine.

> ⚠️ If `LOG_HASH_SALT` is left empty, `src/config.ts` falls back to a
> well-known default string baked into the repo. That fallback provides
> **zero** protection against rainbow-table lookup — anyone with the
> source can rebuild the mapping. Always set your own salt in production.

### 3. Restrict the database volume

On the host:

```bash
chmod 0700 /var/lib/mcp-telegram/data
chown 1000:1000 /var/lib/mcp-telegram/data   # match the container user
```

In your compose/stack file (see `docker-compose.example.yml`),
bind-mount read-write only for the app; do not expose the volume to
other services.

### 4. Enforce TLS

Never expose port 3000 directly. Front the service with:

- Traefik with Let's Encrypt (this is what the maintainer's hosted
  deployment uses).
- nginx + certbot.
- Caddy with automatic HTTPS.

Terminate TLS at the proxy and forward to the container over a private
network.

**QR login needs an unbuffered stream.** `/oauth/authorize/qr` (and
`/login/qr`, `/accounts/*/qr`) push the QR code and the "scanned" event
over Server-Sent Events. nginx buffers proxied responses by default, so
a plain `proxy_pass` block holds the QR event in its buffer instead of
flushing it to the browser — the page shows a spinner ("Connecting…")
and never renders a QR code, even though the container already
generated one. Disable buffering for this app:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 90s;
    add_header X-Accel-Buffering no;
}
```

To tell this apart from the other common cause (outbound connection to
Telegram's servers blocked or filtered — common on some hosting
providers/regions): watch `docker compose logs -f cloud` while you
retry the QR page. If a log line shows the QR token/login being
generated but the browser never updates, it's nginx buffering (fix
above). If instead you see GramJS connection timeouts/errors trying to
reach Telegram, set `TELEGRAM_LOG_LEVEL=debug` temporarily for detail,
and configure an outbound proxy in `.env`:

```env
# MTProxy
TELEGRAM_PROXY_IP=1.2.3.4
TELEGRAM_PROXY_PORT=443
TELEGRAM_PROXY_SECRET=<mtproxy-secret>

# — or SOCKS5 instead of MTProxy —
TELEGRAM_PROXY_IP=1.2.3.4
TELEGRAM_PROXY_PORT=1080
TELEGRAM_PROXY_SOCKS_TYPE=5
TELEGRAM_PROXY_USERNAME=optional
TELEGRAM_PROXY_PASSWORD=optional
```

Restart the container after editing `.env` (`docker compose -f
docker-compose.example.yml up -d`, no rebuild needed — these are runtime
env vars, not build args).

### 5. Configure OAuth rate limits

Defaults (30 requests / 60s per IP across `/oauth/*`) are tuned for a
small public deployment. Tighten for a private one:

```env
OAUTH_RATE_LIMIT=10
OAUTH_RATE_WINDOW_MS=60000
```

Set `OAUTH_RATE_LIMIT=0` to disable (only if you're behind another
rate-limiting layer like Cloudflare).

### 6. Lock down admin endpoints

`/api/stats` and `/api/import-session` are protected only by the bearer
`ADMIN_TOKEN`. For extra defence, restrict them at the proxy layer:

```nginx
location /api/ {
    allow 10.0.0.0/8;
    deny all;
    proxy_pass http://app:3000;
}
```

### 7. Back up — encrypted only

```bash
# Example: encrypted SQLite backup to S3-compatible storage
sqlite3 /var/lib/mcp-telegram/data/cloud.db ".backup /tmp/cloud.db"
gpg --symmetric --cipher-algo AES256 /tmp/cloud.db
aws s3 cp /tmp/cloud.db.gpg s3://your-bucket/backups/
rm /tmp/cloud.db /tmp/cloud.db.gpg
```

Never store the passphrase on the same host as the database.

### 8. Retention

```env
USAGE_LOG_RETENTION_DAYS=90   # 0 = keep forever — not recommended
```

Usage logs accumulate quickly. The default retention of 90 days balances
debugging against blast radius if the DB is exfiltrated.

### 9. Observability (optional)

Pointing `SIGNOZ_ENDPOINT` at a remote OTLP collector lets you correlate
`rate_limit.exceeded` and `http.request` events across replicas. Logs
are PII-safe by default when `LOG_USER_IDS=false`.

### 10. No landing page — `/`, `/privacy`, `/terms` 404 by design

Following the Quick start above (`docker-compose.example.yml` + your own
reverse proxy) gets you a functional-only host: `/`, `/privacy` and
`/terms` return 404. This is expected, not a broken deployment — those
pages were dropped from this app in favor of the operator's own
separate marketing/content site, routed at the proxy layer (see commit
`a0d02ec`, "drop LandingPage/PrivacyPage/TermsPage"). This app only ever
serves the *functional* surface: `/health`, `/oauth/*`, `/login`,
`/admin-login`, `/my/*`, `/mcp`, `/api/*`. If your Claude.ai / ChatGPT
connector's "Server URL" points at the bare origin instead of
`https://your-domain/mcp`, you'll hit this 404 and it will look like the
whole thing is down — it isn't; just fix the URL you register.

If you want a landing/privacy/terms page, stand up your own static site
or content container and route those three paths to it at the proxy
(nginx/Caddy/Traefik) — do not expect this repo to serve them.

### 10a. Public copy — what to review before you publish

The **authorize** page (`/oauth/authorize`) pulls all visible
branding and links from your config:

| Surface | What's templated | Env vars |
| --- | --- | --- |
| Title bar, hero, footer brand | `BRAND_NAME` | `BRAND_NAME` |
| Open-source link, "GitHub" nav, "Self-host" CTA | `SOURCE_REPO_URL` | `SOURCE_REPO_URL` |
| Contact / issues link | `ISSUES_URL`, `ISSUES_LABEL` | `ISSUES_URL`, `ISSUES_LABEL` |
| Email / Telegram contact lines | `CONTACT_EMAIL`, `CONTACT_TELEGRAM` | both |
| Canonical URLs in `<link rel="canonical">` | `ISSUER` | `ISSUER` |

If you set those env vars, the authorize/login pages render with your
branding. There is no separate legal/editorial copy to review here —
this app doesn't ship Privacy or Terms pages (see §10 above); write and
host those yourself if your deployment needs them.

## Incident response

If you suspect the database file has been accessed by an unauthorized
party, **assume every stored MTProto session is compromised**. Options
from fastest to most thorough:

1. **Kill every live session immediately** — stop the service, clear
   the sessions table:
   ```bash
   sqlite3 /var/lib/mcp-telegram/data/cloud.db \
     "DELETE FROM sessions; DELETE FROM oauth_tokens; DELETE FROM oauth_codes;"
   ```
   This forces all users to re-authenticate on next connect. It does
   **not** revoke sessions on Telegram's side — the attacker can still
   use an exfiltrated session string until each user terminates it in
   Telegram.
2. **Notify users out-of-band** and ask them to open Telegram →
   Settings → Devices → Terminate all other sessions. This is the only
   step that invalidates stolen session strings on Telegram's servers.
3. **Rotate** `ADMIN_TOKEN`, `LOG_HASH_SALT`, and `TELEGRAM_API_HASH`
   if you believe they leaked too.
4. **Post-mortem**: check SigNoz / `usage_log` for access from unusual
   IPs before the kill switch.

Document your incident contact in `CONTACT_EMAIL` / `CONTACT_TELEGRAM`
so affected users have somewhere to reach you.

## Upgrading

1. Watch releases: <https://github.com/mcp-telegram/mcp-telegram-cloud/releases>.
2. Pin to a tag, not `main`. Pull the new image, restart the stack.
3. After a bump to `@overpod/mcp-telegram`, re-run the MCP smoke test
   with an existing session to catch protocol breakage early.
4. DB migrations are currently applied at startup — **back up before
   every upgrade**.

## Known limitations

- **Single-process only**. In-memory rate-limit buckets and OAuth state
  are not shared across replicas. Scale vertically or put a shared
  rate-limiter (nginx, Cloudflare) in front.
- **No horizontal HA for session storage**. SQLite is single-writer. For
  multi-host you'd need to swap the storage layer — not in scope.
- **No built-in MFA** for admin endpoints beyond the bearer token.

## Reporting issues

Security issues: see [`SECURITY.md`](../SECURITY.md).

Everything else: GitHub issues on this repo.

## Single-operator mode (optional)

Set `SINGLE_OPERATOR_MODE=true` (plus `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`,
generated via `bun scripts/hash-admin-password.ts`) to replace the public
multi-tenant OAuth identity check (anyone scans their own Telegram QR to
register) with an admin login gate — see
`docs/superpowers/specs/2026-09-18-single-operator-auth-design.md` for the
full design. Leave it unset (or `false`) to run exactly like upstream's
public multi-tenant service.

### Flipping the mode off after running with it on

If this deployment ever ran with `SINGLE_OPERATOR_MODE=true`, the Telegram session is saved under the predictable id `admin:<ADMIN_USERNAME>`. Turning the flag back off without clearing that row (from `user_sessions`, `telegram_accounts`, or `active_account`) leaves that identity reachable through the now-ungated multi-tenant routes — via the `/login/qr?userId=` and `/my/*` cookie vectors, and, sharpest of all, via `/oauth/authorize` itself: a request carrying `Cookie: tg_user=admin:<ADMIN_USERNAME>` hits the restored multi-tenant fast path and mints a working OAuth authorization code with **zero interaction required** — no QR scan, nothing. Either keep the flag on permanently once enabled, or clear the row before flipping it off, using the supported remediation: `POST /api/disconnect-telegram` (admin-token- or admin-session-gated; see `src/routes/admin.tsx`), which tears down the Telegram session and revokes its OAuth tokens in one call.

### Upgrading a deployment that already runs single-operator mode

This flag did not always exist — earlier builds of this fork applied the admin-login gate unconditionally, with no `SINGLE_OPERATOR_MODE` env var to turn it off. If you are running one of those earlier deployments and pull/deploy a newer image built from a codebase that includes this flag, **set `SINGLE_OPERATOR_MODE=true` in that deployment's env BEFORE rolling out the new image.** Without it, the new image boots with the flag at its default (off) and silently restores the original public multi-tenant flow — on a deployment that still has the predictable `admin:<ADMIN_USERNAME>` row from its prior unconditional single-operator operation, which is exactly the zero-interaction `/oauth/authorize` vector described above. If this deployment sits behind an auto-updater (e.g. Watchtower pulling `:latest`), this can happen unattended, with no one around to notice the gate is gone. The fix is purely operational: set the env var first, then roll out the image.
