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
