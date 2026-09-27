/**
 * A request that carries an `Mcp-Session-Id` the server no longer knows (reaped
 * by the idle reaper, or lost in a restart) must get 404 + JSON-RPC -32001.
 *
 * MCP spec (Streamable HTTP, session management): "The server MAY terminate the
 * session at any time, after which it MUST respond to requests containing that
 * session ID with HTTP 404 Not Found." A client that sees 404 starts a new
 * session with a fresh InitializeRequest. Claude Code does exactly that.
 *
 * Before the fix, the unknown ID fell through to "create a new transport", and
 * the SDK answered the non-initialize request with 400 "Server not initialized".
 * Claude treated that as a broken connector and asked the user to reconnect
 * (and redo OAuth) roughly ten minutes after every idle period.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

process.env.TELEGRAM_API_ID ??= "1";
process.env.TELEGRAM_API_HASH ??= "test";
process.env.ISSUER ??= "https://example.com";

const { handleMcpRequest, reapIdleSessions, _trackFullSessionForTest, _resetSessionTrackingForTest } = await import(
  "../mcp-handler.js"
);
const { config } = await import("../config.js");

// The unknown-session path must answer before touching any dependency, so empty
// stand-ins are enough — reaching one of them would throw and fail the test.
const deps = [{}, {}, {}, {}, {}] as unknown as [
  Parameters<typeof handleMcpRequest>[0],
  Parameters<typeof handleMcpRequest>[1],
  Parameters<typeof handleMcpRequest>[2],
  Parameters<typeof handleMcpRequest>[3],
  Parameters<typeof handleMcpRequest>[4],
];

const toolCall = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "telegram-status" } });

function request(method: string, sessionId?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return new Request("https://example.com/mcp", {
    method,
    headers,
    body: method === "POST" ? toolCall : undefined,
  });
}

async function assertSessionNotFound(res: Response): Promise<void> {
  assert.equal(res.status, 404);
  const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string }; id: unknown };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error.code, -32001);
  assert.match(body.error.message, /session not found/i);
}

describe("mcp-handler — unknown session id", () => {
  afterEach(() => {
    _resetSessionTrackingForTest();
  });

  it("answers a POST with an unknown session id with 404 / -32001, not 400", async () => {
    const res = await handleMcpRequest(...deps, "user-a", "Claude", request("POST", "never-issued"));
    await assertSessionNotFound(res);
  });

  it("answers GET and DELETE with an unknown session id with 404 too", async () => {
    await assertSessionNotFound(await handleMcpRequest(...deps, "user-a", "Claude", request("GET", "gone")));
    await assertSessionNotFound(await handleMcpRequest(...deps, "user-a", "Claude", request("DELETE", "gone")));
  });

  it("answers 404 for a session the idle reaper just removed", async () => {
    const now = 1_000_000_000;
    const transport = { close() {}, handleRequest: () => new Response("should not be reached", { status: 500 }) };
    _trackFullSessionForTest("sid-reaped", "claude", "user-a", transport, now - config.mcpIdleReapMs - 1);
    assert.equal(reapIdleSessions(now), 1);

    const res = await handleMcpRequest(...deps, "user-a", "Claude", request("POST", "sid-reaped"));
    await assertSessionNotFound(res);
  });

  it("still routes a known session id to its transport", async () => {
    let routed = 0;
    const transport = {
      close() {},
      handleRequest: () => {
        routed += 1;
        return new Response("ok", { status: 200 });
      },
    };
    _trackFullSessionForTest("sid-live", "claude", "user-a", transport, Date.now());

    const res = await handleMcpRequest(...deps, "user-a", "Claude", request("POST", "sid-live"));
    assert.equal(res.status, 200);
    assert.equal(routed, 1);
  });
});
