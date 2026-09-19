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
