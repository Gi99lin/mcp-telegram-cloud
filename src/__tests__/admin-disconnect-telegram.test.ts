process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";
process.env.ADMIN_USERNAME ??= "alice";
process.env.ADMIN_PASSWORD_HASH ??= "placeholder";
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
