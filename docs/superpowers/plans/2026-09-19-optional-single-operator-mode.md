# Optional Single-Operator Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin-login auth model added in the previous plan (`docs/superpowers/plans/2026-09-18-single-operator-auth.md`) opt-in via a `SINGLE_OPERATOR_MODE` boolean env var, default off, so the branch stays a faithful drop-in for upstream's public multi-tenant behavior when unset — a precondition for proposing it as a PR to `mcp-telegram/mcp-telegram-cloud`.

**Architecture:** Every route the previous plan hard-converted to the admin-gate model gets an `if (config.singleOperatorMode) { ...admin-gate path... } else { ...original multi-tenant path... }` branch, restoring the exact pre-fork behavior on the `else` side. One config flag, no new abstraction — the two code paths sit side by side in the same handler so a future upstream maintainer can read the diff as "here's the new mode, here's what happens when you don't opt in," not a rewrite.

**Tech Stack:** Same as the previous plan — Bun (`bun test`), Hono + `hono/jsx`, `node:crypto`. No new dependencies.

**Spec:** This plan's design was approved directly in chat (no separate spec doc — it's a mechanical parameterization of an already-specified, already-implemented, already-reviewed feature, not new design work). The authority for *why* each gated behavior exists is `docs/superpowers/specs/2026-09-18-single-operator-auth-design.md` and the previous plan's ledger (now in git history on `main`, commits `a6bd217..7da6427`).

## Global Constraints

- `SINGLE_OPERATOR_MODE` is a boolean env var, parsed as `process.env.SINGLE_OPERATOR_MODE === "true"`, matching this file's existing `logUserIds: process.env.LOG_USER_IDS === "true"` convention (not the `intOr`/`optional` numeric-or-string pattern used elsewhere). **Default: `false`** — unset must reproduce the exact behavior on `main` before this plan's changes (i.e., upstream's original multi-tenant flow).
- Every test file that imports anything from `src/config.js` must set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `ISSUER`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` via `process.env.X ??= "..."` before the dynamic `await import(...)` (unchanged rule from the previous plan — `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` are `optional()`, so this is about avoiding stale module-singleton state across tests in the same file, not a hard requirement).
- Tests exercising the single-operator (gated) code path must additionally set `process.env.SINGLE_OPERATOR_MODE ??= "true"` before import. Tests exercising the original multi-tenant (off) path must NOT set it (or must set it to anything other than `"true"`), proving the default is genuinely off.
- **Known anti-pattern, do not repeat it:** setting `ADMIN_PASSWORD_HASH` by importing `../auth/admin.js` (which transitively imports `config.js`) and calling `hashAdminPassword(...)` AFTER that import freezes `config.adminPasswordHash` at `""` for the rest of that file, because `config` is a module-level singleton evaluated once. If a test needs a real, verifiable hash, set it via a fixed literal BEFORE any import: `process.env.ADMIN_PASSWORD_HASH ??= "s1:b4cdda51ef8a9f1af376f3091dd6397e:f24c2fcf63645be51e1da53a7871ec1b617d52f6ca2a1eb7186f5f10d8351847cafb5ca59384d6496030a1972e9cf17c4fe51e10efbde1f0548f91e6afb4a547";` (hash of `"s3cret-pw"`, already used successfully across the previous plan's tests).
- Tests run via `bun test --parallel ./src/__tests__/`. Run `bun run typecheck` and `bun run lint:fix` before every commit.
- The `/oauth/revoke` cascade fix and the `handleAddAccountQr` primary-identity-comparison fix from the previous plan are **general bug fixes, not single-operator-specific** — both stay unconditional (do not gate them). Rationale, already verified while planning this: `/oauth/revoke`'s over-broad cascade is a real bug in the original multi-tenant code too (one Telegram identity connecting two OAuth clients hits it regardless of this flag); `handleAddAccountQr`'s guard fix operates on whatever `ownerUserId` its caller passes (a per-visitor Telegram identity in multi-tenant mode, `config.ownerUserId` in single-operator mode) — the fix is already mode-agnostic by construction, confirmed by reading `src/routes/accounts.ts:52`.
- `/api/disconnect-telegram` (added by the previous plan) is left unconditional/always-mounted — when the flag is off it operates on a `config.ownerUserId` that maps to no real session (`admin:` + empty username), so it's a harmless no-op rather than something that needs gating.

---

### Task 1: Add `config.singleOperatorMode`, gate the boot-time admin-credential check

**Files:**
- Modify: `src/config.ts` (add the flag near `logUserIds`, e.g. around line 156 where `adminUsername`/`adminPasswordHash` are already defined)
- Modify: `src/server.tsx:50-56` (the boot-time throw)
- Test: `src/__tests__/config-single-operator-mode.test.ts`

**Interfaces:**
- Produces: `config.singleOperatorMode: boolean`, exported from `src/config.js`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/config-single-operator-mode.test.ts
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "placeholder";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("config.singleOperatorMode", () => {
  it("defaults to false when SINGLE_OPERATOR_MODE is unset", async () => {
    // isolated env: this file doesn't set SINGLE_OPERATOR_MODE at all
    const { config } = await import("../config.js");
    assert.equal(config.singleOperatorMode, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/config-single-operator-mode.test.ts`
Expected: FAIL — `config.singleOperatorMode` is `undefined`, not `false`.

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, add inside the `config` object, near `logUserIds` (follow that field's exact style):

```typescript
  /** Opt-in single-operator mode: gates /oauth/authorize, /login, /my/* behind
   * an admin-login session instead of upstream's public per-visitor Telegram
   * QR flow. Default false — unset reproduces upstream's original multi-tenant
   * behavior exactly. See docs/superpowers/specs/2026-09-18-single-operator-auth-design.md. */
  singleOperatorMode: process.env.SINGLE_OPERATOR_MODE === "true",
```

In `src/server.tsx`, change the unconditional throw at lines 50-56 to only fire in single-operator mode:

```typescript
// Admin credentials are required only when SINGLE_OPERATOR_MODE is enabled —
// this deployment mode is opt-in, so an unset flag must boot exactly like
// upstream's original multi-tenant server, with no admin-credential demands.
if (config.singleOperatorMode && (!config.adminUsername || !config.adminPasswordHash)) {
  throw new Error(
    "ADMIN_USERNAME and ADMIN_PASSWORD_HASH are required when SINGLE_OPERATOR_MODE=true. " +
      "Generate the hash with: bun scripts/hash-admin-password.ts",
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/config-single-operator-mode.test.ts`
Expected: PASS.

Also add a second test in the same file proving the `true` case, with its own isolated `process.env` setup (separate `describe`, but since `config.ts` is a singleton per test FILE not per `describe`, this second case needs its own dynamically-imported module instance — the established pattern in this codebase for testing two different env states of the same singleton is two SEPARATE test files, not two describes in one file. Split into a second file:

```typescript
// src/__tests__/config-single-operator-mode-enabled.test.ts
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "placeholder";
process.env.SINGLE_OPERATOR_MODE ??= "true";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("config.singleOperatorMode enabled", () => {
  it("is true when SINGLE_OPERATOR_MODE=true", async () => {
    const { config } = await import("../config.js");
    assert.equal(config.singleOperatorMode, true);
  });
});
```

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/server.tsx src/__tests__/config-single-operator-mode.test.ts src/__tests__/config-single-operator-mode-enabled.test.ts
git commit -m "feat(config): add SINGLE_OPERATOR_MODE flag, gate boot-time admin check"
```

---

### Task 2: Branch `/oauth/authorize` and `/authorize/qr` on the flag

**Files:**
- Modify: `src/routes/oauth.tsx:134-266` (the `/authorize` and `/authorize/qr` handlers)
- Modify: `src/__tests__/oauth-authorize-admin-gate.test.ts` (add `SINGLE_OPERATOR_MODE ??= "true"` to its env setup)
- Test: `src/__tests__/oauth-authorize-multi-tenant.test.ts` (new — proves the off path)

**Interfaces:**
- Consumes: `config.singleOperatorMode` (Task 1).
- Produces: no new exports; both handlers now branch internally.

**Context (read before editing):** the current `/authorize` handler (single-operator only) reads, right after the PKCE check:

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

...then falls through to rendering the QR/AuthorizePage. This is the code that needs to become the `if (config.singleOperatorMode)` branch. Upstream's ORIGINAL implementation (before the previous plan, restore this exactly as the `else` branch) used a `tg_user`-cookie-derived hint instead of the fixed admin-gate:

```typescript
function getUserIdHint(c: Context): string | undefined {
  const cookies = c.req.header("cookie") ?? "";
  const match = cookies.match(/tg_user=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}
```

(this function existed in `src/routes/oauth.tsx` before the previous plan deleted it — recreate it exactly as shown, as a module-level function in the same file, restoring it alongside the other module-level functions like `parseTokenParams`.)

- [ ] **Step 1: Write the failing tests**

Add `process.env.SINGLE_OPERATOR_MODE ??= "true";` to the top of `src/__tests__/oauth-authorize-admin-gate.test.ts`'s env-setup block (alongside the existing `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` lines) — this file already tests the admin-gate path exhaustively; it now needs the flag explicitly on to keep passing once the gate becomes conditional.

Create the new off-path test file:

```typescript
// src/__tests__/oauth-authorize-multi-tenant.test.ts
process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "placeholder";
// Deliberately NOT setting SINGLE_OPERATOR_MODE — proving the default (off)
// reproduces upstream's original multi-tenant behavior.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";

const { createOAuthRoutes } = await import("../routes/oauth.js");

const oauthStub = {
  getClient: (id: string) =>
    id === "known"
      ? { client_id: "known", client_name: "Test", redirect_uris: JSON.stringify(["https://client.example/cb"]) }
      : undefined,
  clientCount: () => 0,
  createAuthCode: (_args: unknown) => "test-code",
} as unknown as Parameters<typeof createOAuthRoutes>[0]["oauth"];

function makeApp(tryReconnectSession: (userId: string) => Promise<unknown>) {
  const sessions = { tryReconnectSession } as unknown as Parameters<typeof createOAuthRoutes>[0]["sessions"];
  const app = new Hono();
  app.route("/oauth", createOAuthRoutes({ oauth: oauthStub, sessions }));
  return app;
}

const AUTHORIZE_QS =
  "client_id=known&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=xyz&code_challenge=abc&code_challenge_method=S256";

describe("GET /oauth/authorize — multi-tenant (SINGLE_OPERATOR_MODE unset)", () => {
  it("never redirects to /admin-login — no admin gate in default mode", async () => {
    const app = makeApp(async () => null);
    const res = await app.request(`/oauth/authorize?${AUTHORIZE_QS}`);
    assert.notEqual(res.status, 302);
    // Falls through to the QR page (200), not the admin-login redirect.
    assert.equal(res.status, 200);
  });

  it("uses the tg_user cookie hint, not config.ownerUserId, for the fast path", async () => {
    const app = makeApp(async (userId) => {
      assert.equal(userId, "alice_tg"); // the COOKIE value, not "admin:alice"
      return { fake: "telegram-service" };
    });
    const res = await app.request(`/oauth/authorize?${AUTHORIZE_QS}`, {
      headers: { cookie: "tg_user=alice_tg" },
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    const location = res.headers.get("location") ?? "";
    assert.match(location, /^https:\/\/client\.example\/cb\?code=test-code&state=xyz$/);
  });

  it("with no tg_user cookie and no reconnect, falls through to the QR page (200), not a redirect", async () => {
    const app = makeApp(async () => null);
    const res = await app.request(`/oauth/authorize?${AUTHORIZE_QS}`);
    assert.equal(res.status, 200);
  });
});

describe("GET /oauth/authorize/qr — multi-tenant (SINGLE_OPERATOR_MODE unset)", () => {
  it("never 403s for lacking an admin session — no admin gate in default mode", async () => {
    const app = makeApp(async () => null);
    const res = await app.request(`/oauth/authorize/qr?${AUTHORIZE_QS}`);
    assert.notEqual(res.status, 403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/oauth-authorize-multi-tenant.test.ts`
Expected: FAIL — the current unconditional admin gate 302s/403s every case.

- [ ] **Step 3: Write minimal implementation**

In `src/routes/oauth.tsx`:

1. Restore `getUserIdHint` as a module-level function (shown above), placed near the top of the file alongside `parseTokenParams`.

2. Replace the `/authorize` handler's admin-gate block (shown in Context above) with a branch:

```typescript
    if (config.singleOperatorMode) {
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
    } else {
      // Upstream's original multi-tenant fast path: an optional per-visitor
      // hint cookie (set after a prior QR login) lets a returning visitor skip
      // the QR page if their session is still valid. No admin gate — anyone
      // can reach this far, exactly like upstream.
      const userIdHint = getUserIdHint(c);
      if (userIdHint) {
        const telegram = await sessions.tryReconnectSession(userIdHint);
        if (telegram) {
          const code = oauth.createAuthCode({
            clientId,
            userId: userIdHint,
            redirectUri,
            codeChallenge,
            codeChallengeMethod,
          });
          const url = new URL(redirectUri);
          url.searchParams.set("code", code);
          if (state) url.searchParams.set("state", state);

          logger.info(`Fast OAuth redirect for ${logUser(userIdHint)} (302)`, {
            component: "oauth",
            event: "oauth.fast_redirect",
            userId: logUser(userIdHint),
          });

          incr(OAUTH_FLOW, { step: "authorize", outcome: "fast_redirect" });
          return c.redirect(url.toString(), 302);
        }
      }
    }
```

(The rest of the handler — rendering the QR/AuthorizePage — is unchanged and now serves as the shared fallthrough for both branches, exactly as it did before either mode existed.)

3. In the `/authorize/qr` handler, replace:

```typescript
    if (!isAdminSessionValid(c.req.header("cookie"))) {
      return c.text("Forbidden", 403);
    }
    const userIdHint = config.ownerUserId;
```

with:

```typescript
    let userIdHint: string | undefined;
    if (config.singleOperatorMode) {
      if (!isAdminSessionValid(c.req.header("cookie"))) {
        return c.text("Forbidden", 403);
      }
      userIdHint = config.ownerUserId;
    } else {
      userIdHint = getUserIdHint(c);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/oauth-authorize-multi-tenant.test.ts src/__tests__/oauth-authorize-admin-gate.test.ts`
Expected: PASS, both files.

- [ ] **Step 5: Run the full suite**

Run: `bun test --parallel ./src/__tests__/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/oauth.tsx src/__tests__/oauth-authorize-admin-gate.test.ts src/__tests__/oauth-authorize-multi-tenant.test.ts
git commit -m "feat(oauth): make /authorize admin gate opt-in via SINGLE_OPERATOR_MODE"
```

---

### Task 3: Branch `handleOAuthQrLogin`'s identity-save on the flag

**Files:**
- Modify: `src/qr-login.ts:234-243` (inside `handleOAuthQrLogin`)
- Test: `src/__tests__/qr-login-identity-mode.test.ts` (new — if a suitable existing test already covers `handleOAuthQrLogin`'s save path, extend that one instead; search `src/__tests__/` for one before creating a new file)

**Interfaces:**
- Consumes: `config.singleOperatorMode` (Task 1).

**Context:** current code (lines ~234-243):

```typescript
        if (outcome.ok && outcome.sessionString) {
          const telegram = await connectFromSession(sessions, outcome.sessionString);
          const me = await telegram.getMe();
          // Single-operator fork: always save under the fixed owner id, never
          // the self-reported Telegram identity (that was the multi-tenant
          // model's whole trust boundary — removing it is the point).
          const userId = config.ownerUserId;
```

- [ ] **Step 1: Write the failing test**

Search `src/__tests__/` for an existing test exercising `handleOAuthQrLogin`'s save-on-success path (it may be a fake-Telegram-client-driven test using `SessionManager`'s injectable `telegramFactory`, similar in spirit to `qr-login-add-account-guard.test.ts`). If one exists, add a case there for the off-path; if not, write a new focused test file proving:

```typescript
// (inside whichever file houses this, new or existing)
it("saves under the self-reported Telegram identity when SINGLE_OPERATOR_MODE is unset", async () => {
  // Drive handleOAuthQrLogin to a successful outcome (via the injectable
  // telegramFactory / runQrLogin stub, matching this codebase's existing
  // pattern for testing QR flows without a real Telegram connection) and
  // assert sessions.saveSessionString was called with the me.username-derived
  // id (e.g. "some_handle"), NOT "admin:alice".
});

it("saves under config.ownerUserId when SINGLE_OPERATOR_MODE=true", async () => {
  // Same driving mechanism, SINGLE_OPERATOR_MODE=true in this test's env,
  // assert sessions.saveSessionString was called with config.ownerUserId.
});
```

Use whatever stubbing mechanism this codebase's existing QR-login tests already use for `runQrLogin`/`sessions` — read `src/__tests__/qr-login-add-account-guard.test.ts` and `src/__tests__/qr-login-core.test.ts` first to match the established pattern rather than inventing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test <the test file>`
Expected: FAIL — the off-path case saves under `config.ownerUserId` regardless of the flag.

- [ ] **Step 3: Write minimal implementation**

Replace the four lines shown in Context with:

```typescript
        if (outcome.ok && outcome.sessionString) {
          const telegram = await connectFromSession(sessions, outcome.sessionString);
          const me = await telegram.getMe();
          // Single-operator mode: always save under the fixed owner id, never
          // the self-reported Telegram identity — that identity is exactly
          // what single-operator mode replaces as the trust boundary.
          // Multi-tenant (default): upstream's original behavior, the
          // self-reported Telegram identity IS the owner id.
          const userId = config.singleOperatorMode ? config.ownerUserId : (me.username ?? String(me.id));
```

- [ ] **Step 4: Run test to verify it passes, then the full suite**

Run: `bun test <the test file>` then `bun test --parallel ./src/__tests__/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/qr-login.ts <test file(s)>
git commit -m "feat(qr-login): make QR-bootstrap identity opt-in via SINGLE_OPERATOR_MODE"
```

---

### Task 4: Branch `/my/*`'s `requireUser` on the flag

**Files:**
- Modify: `src/routes/my.tsx:21-44` (the doc comment, `requireUser`, `unauthorizedRedirect`)
- Test: `src/__tests__/my-routes-admin-gate.test.ts` (add `SINGLE_OPERATOR_MODE ??= "true"` to its env setup)
- Test: `src/__tests__/my-routes-multi-tenant.test.ts` (new — proves the off path)

**Interfaces:**
- Consumes: `config.singleOperatorMode` (Task 1).

**Context:** current `requireUser`/`unauthorizedRedirect` (lines 37-44):

```typescript
function requireUser(c: Context, _sessions: SessionManager): string | null {
  if (!isAdminSessionValid(c.req.header("cookie"))) return null;
  return config.ownerUserId;
}

function unauthorizedRedirect(c: Context): Response {
  return c.redirect("/admin-login", 302);
}
```

Upstream's ORIGINAL implementation (before the previous plan, restore as the `else` branch) authenticated via the `tg_user` cookie cross-checked against saved session ids:

```typescript
function getUsernameFromCookie(c: Context): string | undefined {
  const cookies = c.req.header("cookie") ?? "";
  const match = cookies.match(/(?:^|;\s*)tg_user=([^;]+)/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}
```

(recreate this exactly, restoring its anchored-regex/fail-closed-decode behavior — it was correct code, not the buggy version; the previous plan's ledger notes explicitly praised this function's anchoring as the pattern `auth/admin.ts` should have matched.)

- [ ] **Step 1: Write the failing tests**

Add `process.env.SINGLE_OPERATOR_MODE ??= "true";` to `src/__tests__/my-routes-admin-gate.test.ts`'s env setup.

Create `src/__tests__/my-routes-multi-tenant.test.ts` proving, with `SINGLE_OPERATOR_MODE` unset:
- A request to `/my/settings` with a `tg_user` cookie matching a saved session id → succeeds (200 or whatever the route normally returns for a valid, minimally-stubbed session — check what `my-routes-admin-gate.test.ts`'s positive case does and mirror its stub shape, just swap the auth mechanism).
- A request with a `tg_user` cookie NOT matching any saved session id → `unauthorizedRedirect`.
- A request with no cookie at all → `unauthorizedRedirect`.
- A request with a valid `admin_session` cookie but NO `tg_user` cookie → still `unauthorizedRedirect` (proves the admin-session mechanism has no effect at all in default mode — this is the key regression pin for "opt-in, not opt-out").

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/my-routes-multi-tenant.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Replace the doc comment + `requireUser` + `unauthorizedRedirect` block with:

```typescript
/**
 * Routes under `/my/*` are user-facing, authenticated one of two ways
 * depending on `config.singleOperatorMode`:
 *
 * - Single-operator mode: the admin session cookie (see auth/admin.ts), same
 *   gate as /oauth/authorize. There is exactly one owner, so a valid admin
 *   session always maps to the fixed `config.ownerUserId`.
 * - Multi-tenant (default): upstream's original mechanism — the `tg_user`
 *   cookie (the Telegram username reported back from QR login), cross-checked
 *   against saved session ids so a stale/foreign cookie value can't
 *   impersonate a real user.
 */

function getUsernameFromCookie(c: Context): string | undefined {
  const cookies = c.req.header("cookie") ?? "";
  const match = cookies.match(/(?:^|;\s*)tg_user=([^;]+)/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function requireUser(c: Context, sessions: SessionManager): string | null {
  if (config.singleOperatorMode) {
    if (!isAdminSessionValid(c.req.header("cookie"))) return null;
    return config.ownerUserId;
  }
  const username = getUsernameFromCookie(c);
  if (!username) return null;
  const saved = sessions.getSavedUserIds();
  if (!saved.includes(username)) return null;
  return username;
}

function unauthorizedRedirect(c: Context): Response {
  return c.redirect(config.singleOperatorMode ? "/admin-login" : `${config.issuer}/login`, 302);
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

Run: `bun test src/__tests__/my-routes-multi-tenant.test.ts src/__tests__/my-routes-admin-gate.test.ts` then `bun test --parallel ./src/__tests__/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/my.tsx src/__tests__/my-routes-admin-gate.test.ts src/__tests__/my-routes-multi-tenant.test.ts
git commit -m "feat(my): make /my/* admin gate opt-in via SINGLE_OPERATOR_MODE"
```

---

### Task 5: Branch `/login` and `/login/qr` on the flag

**Files:**
- Modify: `src/routes/login.tsx` (both handlers)
- Test: `src/__tests__/login-route-admin-gate.test.ts` (add `SINGLE_OPERATOR_MODE ??= "true"` to its env setup)
- Test: `src/__tests__/login-route-multi-tenant.test.ts` (new — proves the off path)

**Interfaces:**
- Consumes: `config.singleOperatorMode` (Task 1).

**Context:** current file (full content is short, shown in full above in this plan's exploration — GET `/` redirects to `/admin-login` unless `isAdminSessionValid`; GET `/qr` 403s unless `isAdminSessionValid`, then always uses `config.ownerUserId`, ignoring the `userId` query param entirely).

Upstream's ORIGINAL behavior: GET `/` always renders the login page (no gate); GET `/qr` requires a `userId` query param (400 if missing) and passes it straight to `handleQrLogin` — this is the self-service "log into whichever Telegram account you type in" flow the whole rest of upstream's design assumes.

- [ ] **Step 1: Write the failing tests**

Add `process.env.SINGLE_OPERATOR_MODE ??= "true";` to `src/__tests__/login-route-admin-gate.test.ts`'s env setup.

Create `src/__tests__/login-route-multi-tenant.test.ts` proving, with `SINGLE_OPERATOR_MODE` unset:
- `GET /login` (no cookie at all) → 200, renders the page, no redirect.
- `GET /login/qr` with no `userId` query param → 400 `"userId required"` (restore this exact check — it existed before the previous plan removed it).
- `GET /login/qr?userId=someone` with no admin session → the underlying session call IS reached with `"someone"` (the caller-supplied value) — use the same throw-if-wrong-id stub technique the admin-gate test file uses, but here assert it's called with the QUERY PARAM's value, proving the off-path does NOT force `config.ownerUserId`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/login-route-multi-tenant.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```tsx
import { Hono } from "hono";
import { isAdminSessionValid } from "../auth/admin.js";
import { config } from "../config.js";
import { LoginPage } from "../pages/LoginPage.js";
import { handleQrLogin } from "../qr-login.js";
import { detectRequestLocale, islandScripts, reactPagesAvailable, renderReactPage } from "../react-pages.js";
import type { SessionManager } from "../session-manager.js";

export interface LoginRoutesDeps {
  sessions: SessionManager;
}

export function createLoginRoutes({ sessions }: LoginRoutesDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    if (config.singleOperatorMode && !isAdminSessionValid(c.req.header("cookie"))) {
      return c.redirect("/admin-login", 302);
    }

    if (reactPagesAvailable()) {
      const locale = detectRequestLocale(c);
      const html = await renderReactPage("login", {
        locale,
        scripts: islandScripts("language-switcher", "qr-flow"),
      });
      return c.html(html);
    }
    return c.html(<LoginPage />);
  });

  app.get("/qr", async (c) => {
    let userId: string;
    if (config.singleOperatorMode) {
      if (!isAdminSessionValid(c.req.header("cookie"))) {
        return c.text("Forbidden", 403);
      }
      // Single-operator mode: never trust the caller-supplied `userId` query
      // param as the session key — see the fixed docs/superpowers spec for
      // the hijack this closes. The param may still arrive from the
      // client-side qr-flow island (it has its own userId input for the
      // multi-tenant flow) but is ignored here.
      userId = config.ownerUserId;
    } else {
      // Multi-tenant (default): upstream's original self-service flow — the
      // visitor picks which Telegram identity to log into.
      const queryUserId = c.req.query("userId");
      if (!queryUserId) {
        return c.text("userId required", 400);
      }
      userId = queryUserId;
    }

    const stream = await handleQrLogin(sessions, userId, c.req.raw.signal);

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

Run: `bun test src/__tests__/login-route-multi-tenant.test.ts src/__tests__/login-route-admin-gate.test.ts` then `bun test --parallel ./src/__tests__/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/login.tsx src/__tests__/login-route-admin-gate.test.ts src/__tests__/login-route-multi-tenant.test.ts
git commit -m "feat(login): make /login and /login/qr admin gate opt-in via SINGLE_OPERATOR_MODE"
```

---

### Task 6: Conditionally mount `/review`

**Files:**
- Modify: `src/server.tsx` (imports near the top, and the mount block around line 257-271)
- Test: check whether `src/__tests__/review-access.test.ts` needs changes (it likely doesn't — it exercises `createReviewRoutes` directly, not through `server.tsx`'s conditional mount; confirm and leave it alone if so)

**Interfaces:** none new — restores the previously-deleted import and mount, now conditional.

**Context:** current `server.tsx` has a comment block (around lines 266-270) explaining `/review` is deliberately unmounted, and no `createReviewRoutes` import. Before the previous plan, the import was:

```typescript
import { createReviewRoutes } from "./routes/review.js";
```

and the mount (alongside the other `app.route(...)` calls) was:

```typescript
app.route("/review", createReviewRoutes({ sessions }));
```

- [ ] **Step 1: Restore the import and add the conditional mount**

Add the import back near the other route imports in `src/server.tsx`. Replace the explanatory-comment-only block at lines 266-270 with:

```typescript
// Directory-review access (routes/review.tsx) only makes sense for
// upstream's public multi-tenant model — it lets a directory reviewer bypass
// QR login for a demo Telegram account, a scenario that doesn't apply to a
// single-operator deployment. Mount it only when SINGLE_OPERATOR_MODE is off.
if (!config.singleOperatorMode) {
  app.route("/review", createReviewRoutes({ sessions }));
}
```

- [ ] **Step 2: Verify no test regresses**

Run: `bun test --parallel ./src/__tests__/`
Expected: PASS. If a test specifically asserted `/review` is unreachable via the full `server.tsx` app in single-operator mode, it should still pass since `config.singleOperatorMode` in that test's env would be `true`. Check `review-access.test.ts` mounts `createReviewRoutes` directly rather than importing `server.tsx` (server.tsx has top-level side effects and boot checks, so no test should be importing it directly) — if it does something unexpected, report as a concern rather than guessing.

- [ ] **Step 3: Run typecheck and lint**

Run: `bun run typecheck` and `bun run lint:fix`.

- [ ] **Step 4: Commit**

```bash
git add src/server.tsx
git commit -m "feat(server): mount /review only when SINGLE_OPERATOR_MODE is off"
```

---

### Task 7: Docs — document the flag

**Files:**
- Modify: `.env.example`
- Modify: `docs/self-hosting.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add the flag to `.env.example`**

Near the `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` block added by the previous plan, add above it:

```
# ── Single-operator mode (optional) ────────────────────────────────────
# Opt-in: gates /oauth/authorize, /login, /my/* behind the admin login below
# instead of upstream's public per-visitor Telegram QR flow, and unmounts
# /review (a multi-tenant-only feature). Default false — unset reproduces
# upstream's original public multi-tenant behavior exactly.
SINGLE_OPERATOR_MODE=false

# The two vars below are only required when SINGLE_OPERATOR_MODE=true.
```

(Adjust the existing `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` comment block, if it currently reads as always-required, to note it's conditional on `SINGLE_OPERATOR_MODE=true`.)

- [ ] **Step 2: Update `docs/self-hosting.md`**

Find the "Single-operator fork note" section the previous plan added. Rewrite its opening to reflect that this is now an opt-in mode of the same codebase, not a hard fork behavior:

```markdown

## Single-operator mode (optional)

Set `SINGLE_OPERATOR_MODE=true` (plus `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`,
generated via `bun scripts/hash-admin-password.ts`) to replace the public
multi-tenant OAuth identity check (anyone scans their own Telegram QR to
register) with an admin login gate — see
`docs/superpowers/specs/2026-09-18-single-operator-auth-design.md` for the
full design. Leave it unset (or `false`) to run exactly like upstream's
public multi-tenant service.
```

Remove or adjust any surrounding text that previously asserted this behavior unconditionally (e.g. claims that `/review` is never mounted, or that admin credentials are always required) so the doc accurately describes the opt-in nature.

- [ ] **Step 3: Commit**

```bash
git add .env.example docs/self-hosting.md
git commit -m "docs: document SINGLE_OPERATOR_MODE as an opt-in flag"
```

---

## Self-review notes (for whoever executes this plan)

- **Spec coverage:** every behavior the previous plan hardcoded (`/oauth/authorize`, `/authorize/qr`, QR-bootstrap identity, `/my/*`, `/login`, `/login/qr`, `/review` mounting, the boot-time admin check) has a task branching it. The two deliberately-unconditional fixes (`/oauth/revoke`, `handleAddAccountQr`'s guard) are called out explicitly in Global Constraints with the reasoning for why they stay that way — this is the one place a reviewer should double check the reasoning holds, since getting it wrong either way is a real defect (gating a general bug fix behind an opt-in flag ships the bug in default mode; NOT gating something that should be gated defeats the whole plan).
- **Task order:** 2, 4, 5 are independent of each other (different route files) and could in principle run in parallel, but Task 1 must land first (all of them consume `config.singleOperatorMode`) and Task 6 has no code dependency on 2-5 but reads more coherently after them. Sequential 1→7 is simplest and safest given each task's tests need the flag from Task 1 to exist.
- **The `else` branches are not new code — they're restorations.** Every task above quotes the exact original upstream code being restored (recovered from this plan's own exploration of the current file states, cross-referenced against the previous plan's own record of what it deleted/replaced). An implementer should not improvise the off-path behavior; it must match what a real self-hoster running unmodified upstream would see today.
