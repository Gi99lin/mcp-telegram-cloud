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
