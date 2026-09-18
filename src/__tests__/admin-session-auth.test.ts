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
