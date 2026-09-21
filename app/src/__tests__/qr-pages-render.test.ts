import { describe, expect, it } from "bun:test";
import { render as renderAddAccount } from "../pages/add-account.js";
import { render as renderAuthorize } from "../pages/authorize.js";
import { render as renderLogin } from "../pages/login.js";

describe("login page render (SSR)", () => {
  it("emits a doc with noindex, userId input, and the username-templated SSE URL", () => {
    const html = renderLogin({ locale: "en" });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).toContain('id="userId"');
    expect(html).toContain("data-sse-url-template");
  });

  it("localizes (ja) and is not auto-start (user types username first)", () => {
    const html = renderLogin({ locale: "ja" });
    expect(html).toContain('lang="ja"');
    expect(html).not.toContain('data-auto="1"');
  });
});

describe("add-account page render (SSR)", () => {
  it("wires the token into the SSE URL and shows the label", () => {
    const html = renderAddAccount({ locale: "fr", token: "tok123", label: "work" });
    expect(html).toContain("/accounts/add/tok123/qr");
    expect(html).toContain("work");
    expect(html).toContain('lang="fr"');
  });

  it("omits label when null", () => {
    const html = renderAddAccount({ locale: "en", token: "t", label: null });
    expect(html).toContain("/accounts/add/t/qr");
  });
});

describe("authorize page render (SSR) — critical OAuth path", () => {
  const base = {
    clientId: "claude",
    clientName: "Claude",
    redirectUri: "https://claude.ai/cb",
    state: "xyz",
    codeChallenge: "chal123",
    codeChallengeMethod: "S256",
  };

  it("auto-starts and carries every OAuth param in the SSE URL", () => {
    const html = renderAuthorize({ ...base, locale: "es" }).replace(/&amp;/g, "&");
    expect(html).toContain('data-auto="1"');
    expect(html).toContain("/oauth/authorize/qr/cookie");
    expect(html).toContain("client_id=claude");
    expect(html).toContain("redirect_uri=https");
    expect(html).toContain("state=xyz");
    expect(html).toContain("code_challenge=chal123");
    expect(html).toContain("code_challenge_method=S256");
  });

  it("shows the client name and localizes", () => {
    const html = renderAuthorize({ ...base, locale: "es" });
    expect(html).toContain("Claude");
    expect(html).toContain('lang="es"');
    expect(html).toContain('content="noindex, nofollow"');
  });

  it("shows the destination host, which the client name cannot fake", () => {
    // `client_name` is chosen by whoever registered the client (registration is
    // open, RFC 7591), so a page that only says "Claude" tells the person
    // scanning nothing about where the code goes. The host must be visible.
    const html = renderAuthorize({
      ...base,
      clientName: "Claude",
      redirectUri: "https://evil.example/cb",
      locale: "en",
    });
    expect(html).toContain("evil.example");
    expect(html).toContain("Access code will be sent to:");
  });

  it("prefers the origin computed by the route over its own derivation", () => {
    const html = renderAuthorize({
      ...base,
      redirectUri: "cursor://anysphere.cursor-mcp/oauth/callback",
      redirectOriginKey: "cursor://anysphere.cursor-mcp",
      locale: "en",
    });
    expect(html).toContain("cursor://anysphere.cursor-mcp");
  });

  it("localizes the destination label (ru)", () => {
    const html = renderAuthorize({ ...base, locale: "ru" });
    expect(html).toContain(
      "\u041a\u043e\u0434 \u0434\u043e\u0441\u0442\u0443\u043f\u0430 \u0431\u0443\u0434\u0435\u0442 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d \u043d\u0430:",
    );
    expect(html).toContain("claude.ai");
  });
});
