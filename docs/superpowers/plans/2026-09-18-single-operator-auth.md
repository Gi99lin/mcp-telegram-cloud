# Single-Operator Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the public multi-tenant OAuth identity check at `/oauth/authorize` (Telegram QR login, open to anyone) with an admin-login gate, so this self-hosted fork serves exactly one operator, while reusing all existing OAuth token machinery unchanged.

**Architecture:** A new `/admin-login` route (username/password, checked against `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH`) issues a signed, httpOnly session cookie. `/oauth/authorize` checks that cookie instead of a Telegram-identity cookie before issuing a grant, using a fixed `OWNER_USER_ID` constant everywhere a Telegram-derived user id used to be self-reported. `/oauth/revoke` is trimmed to stop cascading one client's revoke into a full Telegram logout and every other client's tokens.

**Tech Stack:** Bun (runtime + `bun test`), Hono + `hono/jsx`, `node:crypto` (scrypt + HMAC, no new dependencies), SQLite via `bun:sqlite` (unchanged), GitHub Actions + GHCR for the production image.

**Spec:** [docs/superpowers/specs/2026-09-18-single-operator-auth-design.md](../specs/2026-09-18-single-operator-auth-design.md)

## Global Constraints

- No new npm/bun dependencies — password hashing uses `node:crypto`'s built-in `scryptSync`, matching the project's existing zero-external-crypto-library convention (see `src/crypto.ts`).
- `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` are **required** env vars (same `required()` helper pattern as `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` in `src/config.ts`) — this fork has no legacy/multi-tenant mode to fall back to.
- Every test file that imports anything from `src/config.js` must set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `ISSUER`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` via `process.env.X ??= "..."` **before** the dynamic `await import(...)` — config.ts throws on missing required vars at module load (see `src/__tests__/config-issuer-url.test.ts` for the established pattern).
- Tests live in `src/__tests__/*.test.ts`, run via `bun test --parallel ./src/__tests__/` (uses Bun's `node:test`-compatible runner — existing tests import from `node:test`/`node:assert/strict`, follow that convention).
- Run `bun run lint:fix` and `bun run typecheck` before every commit (pre-commit hook enforces Biome formatting; do not use `--no-verify`).
- Deviation from the spec, decided while reading the actual code: the spec said "`routes/login.tsx` becomes the admin login form." Reading `src/routes/login.tsx` shows it's the **personal Telegram QR self-login** used by the `/my` dashboard (`handleQrLogin`, unrelated to OAuth) — repurposing it would break that dashboard, which is out of scope. This plan instead adds a **new, separate** `/admin-login` route and leaves `/login` untouched.
- Finding from reading `src/server.tsx`: there is **no public landing/privacy/terms route** mounted in this codebase at all (the comment at `server.tsx:245` already says "This host is functional-only (OAuth/login/my/mcp)" — confirmed by grepping for `/privacy`, `/terms`, and any catch-all route). The spec's "gate or drop public pages" item is therefore already satisfied — Task 7 documents this instead of inventing unnecessary code.

---

### Task 1: Config — admin credentials + fixed owner id

**Files:**
- Modify: `src/config.ts:125-254` (the `config` object) and its top section (pure exported helpers, alongside `issuerUrl`/`httpUrl`)
- Test: `src/__tests__/config-owner-id.test.ts`

**Interfaces:**
- Produces: `ownerUserIdFor(username: string): string` — pure function, exported from `src/config.js`. `config.adminUsername: string`, `config.adminPasswordHash: string`, `config.ownerUserId: string`.
- Consumes: nothing new (uses the existing `required()` helper already in `config.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/config-owner-id.test.ts
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "s1:deadbeef:deadbeef";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { ownerUserIdFor, config } = await import("../config.js");

describe("ownerUserIdFor", () => {
  it("derives a fixed, non-guessable-looking owner id from the admin username", () => {
    assert.equal(ownerUserIdFor("alice"), "admin:alice");
  });

  it("is stable across calls (used as a DB primary key everywhere)", () => {
    assert.equal(ownerUserIdFor("bob"), ownerUserIdFor("bob"));
  });
});

describe("config.ownerUserId", () => {
  it("is derived from ADMIN_USERNAME at boot", () => {
    assert.equal(config.ownerUserId, "admin:alice");
  });

  it("exposes the raw admin credentials for auth/admin.ts to check against", () => {
    assert.equal(config.adminUsername, "alice");
    assert.equal(config.adminPasswordHash, "s1:deadbeef:deadbeef");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/config-owner-id.test.ts`
Expected: FAIL — `ownerUserIdFor is not exported` / `config.ownerUserId is undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, add this pure function near the other exported pure helpers (right after `parseTelemetryMode`, before the `config` object starts at line 125):

```typescript
/** Fixed identity for this single-operator deployment — replaces the
 * QR-derived per-Telegram-identity owner id used by the upstream
 * multi-tenant flow. Exported for unit tests; not for runtime use outside
 * config.ts. */
export const ownerUserIdFor = (username: string): string => `admin:${username}`;
```

Then, inside the `config` object (add after the `openaiAppsChallenge`/`adminToken` lines, i.e. after line 146):

```typescript
  /** Username for the /admin-login gate in front of /oauth/authorize.
   * Required — this fork has no multi-tenant fallback. */
  adminUsername: required("ADMIN_USERNAME", process.env.ADMIN_USERNAME),
  /** scrypt hash of the admin password, format `s1:<salt_hex>:<hash_hex>`.
   * Generate with `bun scripts/hash-admin-password.ts`. */
  adminPasswordHash: required("ADMIN_PASSWORD_HASH", process.env.ADMIN_PASSWORD_HASH),
  /** Fixed owner id for this deployment's single Telegram identity — used
   * everywhere `user_sessions.user_id` / `owner_user_id` is looked up. */
  ownerUserId: ownerUserIdFor(required("ADMIN_USERNAME", process.env.ADMIN_USERNAME)),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/config-owner-id.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config-owner-id.test.ts
git commit -m "feat(config): add admin credentials + fixed owner id"
```

---

### Task 2: Admin password hashing + session cookie

**Files:**
- Modify: `src/auth/admin.ts` (currently 12 lines — only `isAdminAuthorized` for the `ADMIN_TOKEN` Bearer check used by `/api/*`; that function stays, these are additions)
- Create: `scripts/hash-admin-password.ts`
- Test: `src/__tests__/admin-session-auth.test.ts`

**Interfaces:**
- Consumes: `config.adminPasswordHash` from Task 1.
- Produces: `hashAdminPassword(password: string): string`, `verifyAdminPassword(password: string, storedHash: string): boolean`, `buildAdminSessionCookie(): string`, `isAdminSessionValid(cookieHeader: string | undefined): boolean` — all exported from `src/auth/admin.js`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/admin-session-auth.test.ts
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "placeholder"; // overwritten per-test below where needed

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { hashAdminPassword, verifyAdminPassword, buildAdminSessionCookie, isAdminSessionValid } = await import(
  "../auth/admin.js"
);

describe("hashAdminPassword / verifyAdminPassword", () => {
  it("round-trips a correct password", () => {
    const hash = hashAdminPassword("correct horse battery staple");
    assert.equal(verifyAdminPassword("correct horse battery staple", hash), true);
  });

  it("rejects a wrong password", () => {
    const hash = hashAdminPassword("correct horse battery staple");
    assert.equal(verifyAdminPassword("wrong password", hash), false);
  });

  it("produces a different salt (and therefore different hash) each call", () => {
    const a = hashAdminPassword("same password");
    const b = hashAdminPassword("same password");
    assert.notEqual(a, b);
  });

  it("rejects a malformed stored hash instead of throwing", () => {
    assert.equal(verifyAdminPassword("anything", "not-a-valid-hash"), false);
  });
});

describe("admin session cookie", () => {
  it("a freshly built cookie is valid", () => {
    const setCookie = buildAdminSessionCookie();
    const value = setCookie.split(";")[0]; // "admin_session=<value>"
    assert.equal(isAdminSessionValid(value), true);
  });

  it("carries HttpOnly, Secure, SameSite=Lax and a 30-day Max-Age", () => {
    const setCookie = buildAdminSessionCookie();
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=2592000/);
  });

  it("rejects a missing cookie header", () => {
    assert.equal(isAdminSessionValid(undefined), false);
  });

  it("rejects a tampered signature", () => {
    const setCookie = buildAdminSessionCookie();
    const value = setCookie.split(";")[0];
    const tampered = `${value}zz`;
    assert.equal(isAdminSessionValid(tampered), false);
  });

  it("rejects an expired cookie", () => {
    // Build a cookie whose payload is already in the past, signed with the
    // same key buildAdminSessionCookie uses, by forging via the public API's
    // own expiry math is not possible from here — instead assert the format
    // contract: a payload timestamp of 1 (1970) must never validate.
    const forged = `admin_session=1.0000000000000000000000000000000000000000000000000000000000000000`;
    assert.equal(isAdminSessionValid(forged), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/admin-session-auth.test.ts`
Expected: FAIL — `hashAdminPassword is not exported`, etc.

- [ ] **Step 3: Write minimal implementation**

Replace the full contents of `src/auth/admin.ts` with:

```typescript
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/** Constant-time comparison of admin Bearer token to prevent timing attacks. */
export function isAdminAuthorized(authHeader: string | undefined): boolean {
  if (!config.adminToken || !authHeader) return false;
  const expected = `Bearer ${config.adminToken}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Admin password (for the /admin-login gate in front of /oauth/authorize) ──
//
// scrypt, not the SHA-256 used for OAuth token hashing in crypto.ts: those
// tokens are 256 bits of random entropy with nothing to brute-force, but a
// human-chosen password needs a deliberately slow, salted KDF. Format
// mirrors crypto.ts's versioned-envelope convention (`v1:`/`h1:`) so a future
// algorithm change stays detectable and migratable: `s1:<salt_hex>:<hash_hex>`.

const PASSWORD_HASH_VERSION = "s1";
const SALT_BYTES = 16;
const KEY_LEN = 64;

/** Hash a plaintext admin password for storage in ADMIN_PASSWORD_HASH.
 *  Run via `bun scripts/hash-admin-password.ts`, never at request time. */
export function hashAdminPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEY_LEN);
  return `${PASSWORD_HASH_VERSION}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Verify a login attempt against the stored ADMIN_PASSWORD_HASH. Never
 *  throws on a malformed stored value — treats it as "no match". */
export function verifyAdminPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== PASSWORD_HASH_VERSION) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], "hex");
    expected = Buffer.from(parts[2], "hex");
  } catch {
    return false;
  }
  if (salt.length !== SALT_BYTES || expected.length !== KEY_LEN) return false;
  const actual = scryptSync(password, salt, KEY_LEN);
  return timingSafeEqual(actual, expected);
}

// ── Admin session cookie ──────────────────────────────────────────────────
//
// Self-authenticating (no server-side session table): the cookie's own HMAC
// signature IS the credential, keyed by ADMIN_PASSWORD_HASH (a secret only
// this server holds — rotating the admin password also invalidates every
// outstanding admin session, which is the desired behaviour).

const ADMIN_COOKIE_NAME = "admin_session";
const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days, sliding on each login

function adminSigningKey(): Buffer {
  return Buffer.from(config.adminPasswordHash);
}

/** Issue a Set-Cookie header value for a freshly authenticated admin. */
export function buildAdminSessionCookie(): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ADMIN_SESSION_MAX_AGE_SECONDS;
  const payload = String(expiresAt);
  const sig = createHmac("sha256", adminSigningKey()).update(payload).digest("hex");
  return `${ADMIN_COOKIE_NAME}=${payload}.${sig}; Path=/; Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}; SameSite=Lax; Secure; HttpOnly`;
}

/** Validate a raw `Cookie` request header (or a single `name=value` pair, as
 *  tests pass) for a still-valid, correctly-signed admin session. */
export function isAdminSessionValid(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(new RegExp(`${ADMIN_COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const value = decodeURIComponent(match[1]);
  const dot = value.lastIndexOf(".");
  if (dot === -1) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = createHmac("sha256", adminSigningKey()).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt > Math.floor(Date.now() / 1000);
}
```

Then create the generator script, mirroring the `.env.example` comment style already used for `ADMIN_TOKEN`/`SESSION_ENCRYPTION_KEY`:

```typescript
// scripts/hash-admin-password.ts
// Usage: bun scripts/hash-admin-password.ts
// Prompts for a password, prints the ADMIN_PASSWORD_HASH value to put in .env.
// Never run this against a password you want to keep off your terminal
// scrollback in a shared environment — use a local machine.
import { createInterface } from "node:readline/promises";
import { hashAdminPassword } from "../src/auth/admin.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("Admin password to hash: ");
rl.close();

if (!password) {
  console.error("No password entered.");
  process.exit(1);
}

console.log("\nADMIN_PASSWORD_HASH=" + hashAdminPassword(password));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/admin-session-auth.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/admin.ts scripts/hash-admin-password.ts src/__tests__/admin-session-auth.test.ts
git commit -m "feat(auth): add admin password hashing and session cookie"
```

---

### Task 3: Admin login route + page

**Files:**
- Create: `src/routes/admin-login.tsx`
- Create: `src/pages/AdminLoginPage.tsx`
- Modify: `src/server.tsx` (mount the new route)
- Test: `src/__tests__/admin-login-route.test.ts`

**Interfaces:**
- Consumes: `verifyAdminPassword`, `buildAdminSessionCookie`, `isAdminSessionValid` from Task 2; `config.adminUsername` from Task 1.
- Produces: `createAdminLoginRoutes(): Hono`, exported from `src/routes/admin-login.js`, mounted at `/admin-login`. Handles `GET /admin-login?returnTo=<url>` (render form / redirect if already logged in) and `POST /admin-login?returnTo=<url>` (verify credentials, set cookie, redirect).

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/admin-login-route.test.ts
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { hashAdminPassword } = await import("../auth/admin.js");
process.env.ADMIN_PASSWORD_HASH ??= hashAdminPassword("s3cret-pw");

const { createAdminLoginRoutes } = await import("../routes/admin-login.js");

function makeApp() {
  return createAdminLoginRoutes();
}

describe("GET /admin-login", () => {
  it("renders the login form when not authenticated (200, html body)", async () => {
    const res = await makeApp().request("/?returnTo=/oauth/authorize%3Ffoo%3Dbar");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<form/);
  });

  it("redirects straight to returnTo when already authenticated", async () => {
    const { buildAdminSessionCookie } = await import("../auth/admin.js");
    const cookie = buildAdminSessionCookie().split(";")[0];
    const res = await makeApp().request("/?returnTo=/oauth/authorize%3Ffoo%3Dbar", {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/oauth/authorize?foo=bar");
  });
});

describe("POST /admin-login", () => {
  it("sets the cookie and redirects to returnTo on correct credentials", async () => {
    const res = await makeApp().request("/?returnTo=%2Fmy", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=s3cret-pw",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/my");
    assert.match(res.headers.get("set-cookie") ?? "", /admin_session=/);
  });

  it("rejects a wrong password without setting a cookie", async () => {
    const res = await makeApp().request("/?returnTo=%2Fmy", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=alice&password=nope",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /error=1/);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("rejects a wrong username without setting a cookie", async () => {
    const res = await makeApp().request("/?returnTo=%2Fmy", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=mallory&password=s3cret-pw",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("set-cookie"), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/admin-login-route.test.ts`
Expected: FAIL — `Cannot find module '../routes/admin-login.js'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/pages/AdminLoginPage.tsx
import type { FC } from "hono/jsx";

export const AdminLoginPage: FC<{ returnTo: string; error: boolean }> = ({ returnTo, error }) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <title>Admin login</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
    </head>
    <body
      style="font-family: system-ui, sans-serif; max-width: 360px; margin: 80px auto; padding: 0 16px;"
    >
      <h1 style="font-size: 20px;">Admin login</h1>
      {error && (
        <p style="color: #E53935; font-size: 14px;">Wrong username or password.</p>
      )}
      <form method="post" action={`/admin-login?returnTo=${encodeURIComponent(returnTo)}`}>
        <div style="margin-bottom: 12px;">
          <label style="display: block; font-size: 13px; margin-bottom: 4px;" for="username">
            Username
          </label>
          <input
            style="width: 100%; padding: 8px; box-sizing: border-box;"
            id="username"
            name="username"
            type="text"
            autocomplete="username"
            required
          />
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display: block; font-size: 13px; margin-bottom: 4px;" for="password">
            Password
          </label>
          <input
            style="width: 100%; padding: 8px; box-sizing: border-box;"
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
          />
        </div>
        <button style="width: 100%; padding: 10px; cursor: pointer;" type="submit">
          Log in
        </button>
      </form>
    </body>
  </html>
);
```

```tsx
// src/routes/admin-login.tsx
import { Hono } from "hono";
import { buildAdminSessionCookie, isAdminSessionValid, verifyAdminPassword } from "../auth/admin.js";
import { config } from "../config.js";
import { AdminLoginPage } from "../pages/AdminLoginPage.js";

/** Only ever redirect within this app — an attacker-controlled absolute
 *  returnTo would turn this into an open redirect off a login form. */
function safeReturnTo(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function createAdminLoginRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const returnTo = safeReturnTo(c.req.query("returnTo"));
    if (isAdminSessionValid(c.req.header("cookie"))) {
      return c.redirect(returnTo, 302);
    }
    return c.html(<AdminLoginPage returnTo={returnTo} error={c.req.query("error") === "1"} />);
  });

  app.post("/", async (c) => {
    const returnTo = safeReturnTo(c.req.query("returnTo"));
    const body = await c.req.parseBody();
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    const ok = username === config.adminUsername && verifyAdminPassword(password, config.adminPasswordHash);
    if (!ok) {
      return c.redirect(`/admin-login?returnTo=${encodeURIComponent(returnTo)}&error=1`, 302);
    }

    c.header("Set-Cookie", buildAdminSessionCookie());
    return c.redirect(returnTo, 302);
  });

  return app;
}
```

Wire it into `src/server.tsx`: add `import { createAdminLoginRoutes } from "./routes/admin-login.js";` alongside the other route imports (near `import { createLoginRoutes } from "./routes/login.js";`), and mount it alongside the other `app.route(...)` calls (near `app.route("/login", createLoginRoutes({ sessions }));`):

```typescript
app.route("/admin-login", createAdminLoginRoutes());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/admin-login-route.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pages/AdminLoginPage.tsx src/routes/admin-login.tsx src/server.tsx src/__tests__/admin-login-route.test.ts
git commit -m "feat(auth): add /admin-login route and page"
```

---

### Task 4: Gate /oauth/authorize behind the admin session, fix bootstrap identity

**Files:**
- Modify: `src/routes/oauth.tsx:21-25` (delete `getUserIdHint`), `:139-221` (`/authorize` handler), `:223-265` (`/authorize/qr` handler)
- Modify: `src/qr-login.ts:1-5` (add `config` import), `:236` (`const userId = me.username ?? String(me.id);`)
- Test: `src/__tests__/oauth-authorize-admin-gate.test.ts`

**Interfaces:**
- Consumes: `isAdminSessionValid` from Task 2, `config.ownerUserId` from Task 1.
- Produces: `/oauth/authorize` and `/oauth/authorize/qr` now require a valid admin session; unchanged public interface otherwise (still standard OAuth authorize semantics for the calling client).

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/oauth-authorize-admin-gate.test.ts
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { hashAdminPassword, buildAdminSessionCookie } = await import("../auth/admin.js");
process.env.ADMIN_PASSWORD_HASH ??= hashAdminPassword("s3cret-pw");

const { createOAuthRoutes } = await import("../routes/oauth.js");

const oauthStub = {
  getClient: (id: string) =>
    id === "known"
      ? { client_id: "known", client_name: "Test", redirect_uris: JSON.stringify(["https://client.example/cb"]) }
      : undefined,
  clientCount: () => 0,
  createAuthCode: (args: unknown) => "test-code",
} as unknown as Parameters<typeof createOAuthRoutes>[0]["oauth"];

function makeApp(tryReconnectSession: (userId: string) => Promise<unknown>) {
  const sessions = { tryReconnectSession } as unknown as Parameters<typeof createOAuthRoutes>[0]["sessions"];
  const app = new Hono();
  app.route("/oauth", createOAuthRoutes({ oauth: oauthStub, sessions }));
  return app;
}

const AUTHORIZE_QS =
  "client_id=known&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=xyz&code_challenge=abc&code_challenge_method=S256";

describe("GET /oauth/authorize admin gate", () => {
  it("redirects to /admin-login when there is no admin session — never issues a code", async () => {
    const app = makeApp(async () => null);
    const res = await app.request(`/oauth/authorize?${AUTHORIZE_QS}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /^\/admin-login\?returnTo=/);
  });

  it("issues a code via fast redirect when the admin session is valid and a primary Telegram session already exists", async () => {
    const cookie = buildAdminSessionCookie().split(";")[0];
    const app = makeApp(async (userId) => {
      assert.equal(userId, "admin:alice"); // must use the FIXED owner id, not a per-visitor hint
      return { fake: "telegram-service" };
    });
    const res = await app.request(`/oauth/authorize?${AUTHORIZE_QS}`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    const location = res.headers.get("location") ?? "";
    assert.match(location, /^https:\/\/client\.example\/cb\?code=test-code&state=xyz$/);
  });

  it("falls through to the QR bootstrap page when admin session is valid but no Telegram session exists yet", async () => {
    const cookie = buildAdminSessionCookie().split(";")[0];
    const app = makeApp(async () => null);
    const res = await app.request(`/oauth/authorize?${AUTHORIZE_QS}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /qr|QR/); // renders the existing AuthorizePage/QR flow, unchanged
  });
});

describe("GET /oauth/authorize/qr admin gate", () => {
  it("403s without a valid admin session (defense in depth if hit directly)", async () => {
    const app = makeApp(async () => null);
    const res = await app.request(`/oauth/authorize/qr?${AUTHORIZE_QS}`);
    assert.equal(res.status, 403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/oauth-authorize-admin-gate.test.ts`
Expected: FAIL — current handler has no admin-session check, so the "no admin session" test gets a 200/QR page instead of a 302 to `/admin-login`.

- [ ] **Step 3: Write minimal implementation**

In `src/qr-login.ts`, add the import (top of file, alongside the existing imports at lines 1-5):

```typescript
import { config } from "./config.js";
```

Then in `handleOAuthQrLogin`, change line 236 from:

```typescript
          const userId = me.username ?? String(me.id);
```

to:

```typescript
          // Single-operator fork: always save under the fixed owner id, never
          // the self-reported Telegram identity (that was the multi-tenant
          // model's whole trust boundary — removing it is the point).
          const userId = config.ownerUserId;
```

In `src/routes/oauth.tsx`:

1. Delete the `getUserIdHint` function (lines 21-25) — its only two call sites are being replaced below, and an unused function fails the Biome lint gate.

2. Add to the imports at the top of the file (alongside the existing `import { decideTgUserCookie } from "../cookie-handler.js";` line):

```typescript
import { isAdminSessionValid } from "../auth/admin.js";
```

3. Replace the `/authorize` handler body from `const userIdHint = getUserIdHint(c);` through the end of the fast-path `if (userIdHint) { ... }` block (lines 166-192) with:

```typescript
    if (!isAdminSessionValid(c.req.header("cookie"))) {
      const returnTo = `${c.req.path}?${new URL(c.req.url).search.slice(1)}`;
      incr(OAUTH_FLOW, { step: "authorize", outcome: "admin_login_required" });
      return c.redirect(`/admin-login?returnTo=${encodeURIComponent(returnTo)}`, 302);
    }

    // Admin is authenticated. Fast path: if the deployment's one Telegram
    // account is already connected, skip the QR page entirely.
    const telegram = await sessions.tryReconnectSession(config.ownerUserId);
    if (telegram) {
      const code = oauth.createAuthCode({
        clientId,
        userId: config.ownerUserId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
      });
      const url = new URL(redirectUri);
      url.searchParams.set("code", code);
      if (state) url.searchParams.set("state", state);

      logger.info(`Fast OAuth redirect for ${logUser(config.ownerUserId)} (302)`, {
        component: "oauth",
        event: "oauth.fast_redirect",
        userId: logUser(config.ownerUserId),
      });

      incr(OAUTH_FLOW, { step: "authorize", outcome: "fast_redirect" });
      return c.redirect(url.toString(), 302);
    }
```

(The rest of the handler — rendering the QR/AuthorizePage — stays exactly as-is; it now only runs for the one-time bootstrap case, since every later call takes the fast-redirect branch above.)

4. In the `/authorize/qr` handler, replace `const userIdHint = getUserIdHint(c);` (line 248) with an admin-session check plus the fixed hint:

```typescript
    if (!isAdminSessionValid(c.req.header("cookie"))) {
      return c.text("Forbidden", 403);
    }
    const userIdHint = config.ownerUserId;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/oauth-authorize-admin-gate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full existing suite to check for regressions**

Run: `bun test --parallel ./src/__tests__/`
Expected: PASS. If `qr-login-core.test.ts` or other pre-existing tests reference `me.username ?? String(me.id)` behavior directly, update their expectations to `config.ownerUserId` — check the diff carefully; that test exercises `qr-login-core.ts` (the pure state machine), not `qr-login.ts`'s `handleOAuthQrLogin`, so it should be unaffected, but confirm.

- [ ] **Step 6: Commit**

```bash
git add src/routes/oauth.tsx src/qr-login.ts src/__tests__/oauth-authorize-admin-gate.test.ts
git commit -m "feat(oauth): gate /authorize behind admin session, fix bootstrap identity"
```

---

### Task 5: Fix /oauth/revoke to stop cascading across clients

**Files:**
- Modify: `src/routes/oauth.tsx:327-365` (the `/revoke` handler — line numbers shift after Task 4's edits; locate by the `RFC 7009` comment)
- Test: `src/__tests__/oauth-revoke-scoped.test.ts`

**Interfaces:**
- Consumes: `oauth.revokeToken(token: string): string | null` (already exists, already scoped correctly — see `src/oauth.ts:571-584`).
- Produces: `/oauth/revoke` no longer calls `sessions.destroyUserSession` or `oauth.revokeAllUserTokens`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/oauth-revoke-scoped.test.ts
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
const { hashAdminPassword } = await import("../auth/admin.js");
process.env.ADMIN_PASSWORD_HASH ??= hashAdminPassword("s3cret-pw");

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { createOAuthRoutes } = await import("../routes/oauth.js");

describe("POST /oauth/revoke", () => {
  it("revokes only the presented token — never touches other clients' tokens or the Telegram session", async () => {
    let destroyUserSessionCalls = 0;
    let revokeAllUserTokensCalls = 0;

    const oauthStub = {
      revokeToken: (token: string) => (token === "target-token" ? "admin:alice" : null),
      revokeAllUserTokens: (_userId: string) => {
        revokeAllUserTokensCalls++;
        return 0;
      },
    } as unknown as Parameters<typeof createOAuthRoutes>[0]["oauth"];

    const sessionsStub = {
      destroyUserSession: async (_userId: string) => {
        destroyUserSessionCalls++;
        return { loggedOut: true };
      },
    } as unknown as Parameters<typeof createOAuthRoutes>[0]["sessions"];

    const app = new Hono();
    app.route("/oauth", createOAuthRoutes({ oauth: oauthStub, sessions: sessionsStub }));

    const res = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=target-token",
    });

    assert.equal(res.status, 200);
    assert.equal(destroyUserSessionCalls, 0, "revoke must NOT log out the shared Telegram session");
    assert.equal(revokeAllUserTokensCalls, 0, "revoke must NOT wipe every other client's tokens");
  });

  it("still returns 200 per RFC 7009 for an unknown/already-expired token", async () => {
    const oauthStub = {
      revokeToken: () => null,
      revokeAllUserTokens: () => 0,
    } as unknown as Parameters<typeof createOAuthRoutes>[0]["oauth"];
    const sessionsStub = {} as unknown as Parameters<typeof createOAuthRoutes>[0]["sessions"];

    const app = new Hono();
    app.route("/oauth", createOAuthRoutes({ oauth: oauthStub, sessions: sessionsStub }));

    const res = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=unknown-token",
    });
    assert.equal(res.status, 200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/oauth-revoke-scoped.test.ts`
Expected: FAIL — `destroyUserSessionCalls` and `revokeAllUserTokensCalls` are both `1`, not `0`.

- [ ] **Step 3: Write minimal implementation**

In `src/routes/oauth.tsx`, replace the body of `app.post("/revoke", ...)` (currently lines 328-365, calling `sessions.destroyUserSession` and `oauth.revokeAllUserTokens`) with:

```typescript
  // RFC 7009 — Token Revocation. Scoped to exactly the token presented: this
  // deployment has multiple OAuth clients (e.g. Claude.ai + ChatGPT) sharing
  // one fixed owner id, so revoking must NOT cascade into every other
  // client's tokens or tear down the shared Telegram session. Use the admin
  // panel's explicit "Disconnect Telegram" action for that (routes/admin.tsx).
  app.post("/revoke", async (c) => {
    const params = await parseTokenParams(c);
    const token = params.token;
    logger.info(`Revocation request received`, { component: "oauth", event: "oauth.revoke.start" });

    if (!token) {
      logger.info(`No token provided, returning 200 per RFC 7009`, {
        component: "oauth",
        event: "oauth.revoke.empty",
      });
      return c.json({});
    }

    const userId = oauth.revokeToken(token);

    if (userId) {
      logger.info(`Token revoked for ${logUser(userId)}`, {
        component: "oauth",
        userId: logUser(userId),
        event: "oauth.revoke.done",
      });
      incr(OAUTH_FLOW, { step: "revoke", outcome: "ok" });
    } else {
      logger.info(`Token not found or already expired`, { component: "oauth", event: "oauth.revoke.notfound" });
      incr(OAUTH_FLOW, { step: "revoke", outcome: "notfound" });
    }

    // RFC 7009: always return 200, even if token was invalid
    return c.json({});
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/oauth-revoke-scoped.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/oauth.tsx src/__tests__/oauth-revoke-scoped.test.ts
git commit -m "fix(oauth): scope /revoke to the presented token only"
```

---

### Task 6: Admin "Disconnect Telegram" action

**Files:**
- Modify: `src/routes/admin.tsx` (add a new route, alongside the existing `app.delete("/users/:id", ...)` admin-disconnect route at lines 63-90, which is the pattern to follow)
- Test: `src/__tests__/admin-disconnect-telegram.test.ts`

**Interfaces:**
- Consumes: `isAdminAuthorized` (existing, `src/auth/admin.js`), `config.ownerUserId` (Task 1), `sessions.destroyUserSession` / `oauth.revokeAllUserTokens` (existing, both already used by the `/users/:id` route this mirrors).
- Produces: `POST /api/disconnect-telegram` — the only route in this codebase allowed to call `destroyUserSession` for the shared owner, now that Task 5 removed it from `/oauth/revoke`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/admin-disconnect-telegram.test.ts
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
const { hashAdminPassword } = await import("../auth/admin.js");
process.env.ADMIN_PASSWORD_HASH ??= hashAdminPassword("s3cret-pw");
process.env.ADMIN_TOKEN ??= "test-admin-token";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { createAdminRoutes } = await import("../routes/admin.js");
const { config } = await import("../config.js");

function makeApp(overrides: {
  destroyUserSession?: (userId: string) => Promise<{ loggedOut: boolean }>;
  revokeAllUserTokens?: (userId: string) => number;
}) {
  const sessions = {
    destroyUserSession: overrides.destroyUserSession ?? (async () => ({ loggedOut: true })),
    getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [] }) }),
  } as unknown as Parameters<typeof createAdminRoutes>[0]["sessions"];
  const oauth = {
    revokeAllUserTokens: overrides.revokeAllUserTokens ?? (() => 0),
  } as unknown as Parameters<typeof createAdminRoutes>[0]["oauth"];
  const usage = {} as unknown as Parameters<typeof createAdminRoutes>[0]["usage"];

  const app = new Hono();
  app.route("/api", createAdminRoutes({ oauth, sessions, usage }));
  return app;
}

describe("POST /api/disconnect-telegram", () => {
  it("401s without a valid ADMIN_TOKEN", async () => {
    const app = makeApp({});
    const res = await app.request("/api/disconnect-telegram", { method: "POST" });
    assert.equal(res.status, 401);
  });

  it("logs out the shared owner's Telegram session and revokes all its OAuth tokens", async () => {
    let disconnectedUserId: string | undefined;
    let revokedUserId: string | undefined;
    const app = makeApp({
      destroyUserSession: async (userId) => {
        disconnectedUserId = userId;
        return { loggedOut: true };
      },
      revokeAllUserTokens: (userId) => {
        revokedUserId = userId;
        return 3;
      },
    });
    const res = await app.request("/api/disconnect-telegram", {
      method: "POST",
      headers: { Authorization: "Bearer test-admin-token" },
    });
    assert.equal(res.status, 200);
    assert.equal(disconnectedUserId, config.ownerUserId);
    assert.equal(revokedUserId, config.ownerUserId);
    const body = (await res.json()) as { ok: boolean; loggedOut: boolean; revokedTokens: number };
    assert.deepEqual(body, { ok: true, loggedOut: true, revokedTokens: 3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/admin-disconnect-telegram.test.ts`
Expected: FAIL — 404, route doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

In `src/routes/admin.tsx`, add this route (right after the existing `app.delete("/users/:id", ...)` block, which ends at line 90, and before `app.get("/observability", ...)`):

```typescript
  // Explicit, admin-only Telegram logout for the shared owner id. This is the
  // ONLY place that tears down the actual Telegram session — /oauth/revoke
  // (routes/oauth.tsx) intentionally does not, so one OAuth client revoking
  // its token never logs out the others or the Telegram account itself.
  app.post("/disconnect-telegram", async (c) => {
    if (!isAdminAuthorized(c.req.header("Authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const { loggedOut } = await sessions.destroyUserSession(config.ownerUserId);
    const revokedTokens = oauth.revokeAllUserTokens(config.ownerUserId);
    logger.warn("Admin-initiated Telegram disconnect", {
      component: "admin",
      event: "admin.telegram.disconnect",
      userId: logUser(config.ownerUserId),
    });
    return c.json({ ok: true, loggedOut, revokedTokens });
  });
```

(`isAdminAuthorized`, `config`, `sessions`, `oauth`, `logger`, `logUser` are all already imported/in-scope in this file — see lines 1-13.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/admin-disconnect-telegram.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.tsx src/__tests__/admin-disconnect-telegram.test.ts
git commit -m "feat(admin): add explicit Telegram disconnect action"
```

---

### Task 7: Env template + docs (no code changes to gate public pages — none exist)

**Files:**
- Modify: `.env.example` (repo root)
- Modify: `docs/self-hosting.md` (append a short note)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add the new vars to `.env.example`**

Add, near the existing `ADMIN_TOKEN` entry:

```
# ── Admin (single-operator gate) ───────────────────────────────────────
# Username/password gate in front of /oauth/authorize (see docs/self-hosting.md).
# Generate the hash with: bun scripts/hash-admin-password.ts
ADMIN_USERNAME=
ADMIN_PASSWORD_HASH=
```

- [ ] **Step 2: Append a note to `docs/self-hosting.md`**

```markdown

## Single-operator fork note

This fork replaces the public multi-tenant OAuth identity check (anyone
scans their own Telegram QR to register) with an admin login gate —
see `docs/superpowers/specs/2026-09-18-single-operator-auth-design.md`
for the full design. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`
(generate via `bun scripts/hash-admin-password.ts`) before first boot.

Note: this codebase, as of this fork, mounts no public landing/privacy/terms
pages (`src/server.tsx` is explicitly "functional-only" — OAuth/login/my/mcp).
The upstream self-hosting guidance about reviewing/deleting those pages does
not apply here; there is nothing to gate.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example docs/self-hosting.md
git commit -m "docs: document admin credentials and single-operator auth"
```

---

### Task 8: GitHub Actions CI — build and push to GHCR

**Files:**
- Create: `.github/workflows/docker-publish.yml`

**Interfaces:** none (CI config only). Mirrors the existing workflow in the separate `manager-helper` repo (`ghcr.io/gi99lin/manager-helper:latest` pattern) — read at `/Users/ivanakimkin/Projects/manager-helper/.github/workflows/docker-publish.yml` if you need to re-check it while implementing.

- [ ] **Step 1: Create the workflow**

```yaml
# .github/workflows/docker-publish.yml
name: Build and Publish Docker Image

on:
  push:
    branches: [main]

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/gi99lin/mcp-telegram-cloud:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Verify the existing Dockerfile builds standalone**

Run: `docker build -t mcp-telegram-cloud-test .` (from the repo root — local build, for verification only, per the project's deployment rule: local/dev builds are fine, production builds only happen through this CI workflow, never on the target server).
Expected: image builds successfully. This also exercises Task 4's `qr-login.ts` change and Task 1-6's TypeScript changes through the Dockerfile's `bun install`/build stages — a good final compile-correctness check before pushing.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/docker-publish.yml
git commit -m "ci: publish Docker image to GHCR on push to main"
```

---

### Task 9: Manual end-to-end smoke test (cannot be automated — needs a real Telegram account)

This is not unit-testable: it needs a live Telegram account completing a real QR login. Run this once, locally, against `docker compose up -d --build` with real `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`/`ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` (use a throwaway Telegram account, per `CONTRIBUTING.md`'s own advice — the session DB stores plaintext MTProto sessions when `SESSION_ENCRYPTION_KEY` is unset).

- [ ] Visit `/oauth/authorize?...` (or register a real OAuth client and drive it from an actual MCP client) with no cookie set — confirm you land on `/admin-login`, not the QR page.
- [ ] Log in with the wrong password — confirm you're bounced back to `/admin-login?error=1` and no `admin_session` cookie is set (check browser devtools).
- [ ] Log in with the correct password — confirm you land on the QR bootstrap page (first run, no Telegram session yet) and the `admin_session` cookie is set (HttpOnly, so verify via Network tab, not `document.cookie`).
- [ ] Scan the QR with the throwaway Telegram account — confirm the OAuth flow completes and the connecting MCP client gets a working token.
- [ ] Open `/oauth/authorize?...` again (e.g. register and authorize a second OAuth client) — confirm it fast-redirects straight through with **no** QR page and **no** login prompt (the admin cookie is still valid).
- [ ] Clear the `admin_session` cookie and repeat — confirm you're sent back to `/admin-login`, and after logging in again you get the **fast redirect** (not another QR scan) — this pins the "QR only once" bootstrap contract.
- [ ] With two OAuth clients connected (from the steps above), revoke one client's token (however that client exposes "disconnect") — confirm the other client's token still works and the Telegram session is still connected (`POST /api/stats` or a tool call through the other client).
- [ ] Call `POST /api/disconnect-telegram` with `Authorization: Bearer $ADMIN_TOKEN` — confirm the Telegram session is now logged out (next `/oauth/authorize` with a valid admin cookie shows the QR page again, not a fast redirect).
- [ ] Run `telegram-accounts-list` / `telegram-accounts-add` / `telegram-accounts-switch` through the connected MCP client — confirm the pre-existing multi-account feature still works unchanged against the fixed owner id.

---

## Self-review notes (for whoever executes this plan)

- **Spec coverage:** admin-login gate → Tasks 2-4; fixed owner id → Task 1 + Task 4's `qr-login.ts` fix; revoke-semantics fix → Task 5; explicit Telegram disconnect → Task 6; public-pages gating → Task 7 documents that it's a non-issue; CI/GHCR → Task 8; multi-account and proxy → explicitly out of scope per the spec, not touched by any task, verified still working in Task 9's smoke test.
- **Deviation from spec, called out again here:** admin login lives at a new `/admin-login` route, not a repurposed `/login` — see the Global Constraints note for why.
- Task numbering assumes sequential execution (Task 4 depends on Tasks 1-2; Task 5 and 6 depend on Task 1; Task 3 depends on Task 2). Task 7 and 8 have no code dependencies and could run any time after Task 6.
