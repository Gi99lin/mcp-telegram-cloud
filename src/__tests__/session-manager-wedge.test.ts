/**
 * issue #19 — the permanent wedge.
 *
 * Reported symptom: after some Telegram hiccup, one user's tool calls hang forever;
 * reinstalling the connector, redoing OAuth and waiting past the idle reaper all fail to
 * recover them, and only a container restart helps.
 *
 * Mechanism (pre-v2.59.0): `getOrCreateSessionImpl` / `ensureActiveSession` awaited GramJS
 * `ensureConnected()` INSIDE `withLock(userId, …)`. A half-open socket makes that promise
 * never settle, so the per-user lock chain is pinned and every later call for that user
 * queues behind it forever. Nothing outside process memory is involved — which is exactly
 * why re-auth could not fix it.
 *
 * These tests fail (by hanging into the runner's timeout) without the deadlines.
 */
process.env.ISSUER ??= "https://session-wedge-test.invalid";
process.env.TELEGRAM_API_ID ??= "12345";
process.env.TELEGRAM_API_HASH ??= "test-hash";
process.env.TELEGRAM_CONNECT_TIMEOUT_MS = "50";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TelegramService } from "@overpod/mcp-telegram/service";
import type { SessionManager as SessionManagerType } from "../session-manager.js";

const { SessionManager } = (await import("../session-manager.js")) as {
  SessionManager: typeof SessionManagerType;
};

const never = () => new Promise<never>(() => {});

/**
 * A client that connects normally and is later wedged by the test, reproducing the real
 * sequence: the session is healthy and pooled, then the MTProto socket goes half-open.
 *
 * `wedge("sticky")` keeps `isConnected()` returning true — the lying flag behind upstream
 * issue #71 — so no reconnect is attempted and the hang lands in the tool handler instead.
 * `wedge("dropped")` reports disconnected, which sends `getOrCreateSession` into
 * `ensureConnected()` — the await that used to pin the per-user lock forever.
 */
class WedgeableTelegramService {
  readonly calls: string[] = [];
  private connected = false;
  private wedged: "no" | "sticky" | "dropped" = "no";
  private sessionString: string | undefined;

  /** Never resolves connect()/ensureConnected() from construction on (cold-start wedge). */
  constructor(private readonly hangOnConnect = false) {}

  wedge(mode: "sticky" | "dropped"): void {
    this.wedged = mode;
  }

  async connect(): Promise<boolean> {
    this.calls.push("connect");
    if (this.hangOnConnect) return never();
    this.connected = true;
    return true;
  }
  isConnected(): boolean {
    if (this.wedged === "sticky") return true;
    if (this.wedged === "dropped") return false;
    return this.connected;
  }
  async ensureConnected(): Promise<boolean> {
    this.calls.push("ensureConnected");
    if (this.wedged !== "no") return never();
    return this.connected;
  }
  async disconnect(): Promise<void> {
    this.calls.push("disconnect");
    this.connected = false;
  }
  setSessionString(s: string): void {
    this.sessionString = s;
  }
  getSessionString(): string | undefined {
    return this.sessionString;
  }
}

/** A healthy client, used as the replacement built after the wedged one is discarded. */
class HealthyTelegramService {
  readonly calls: string[] = [];
  private connected = false;
  private sessionString: string | undefined;

  async connect(): Promise<boolean> {
    this.calls.push("connect");
    this.connected = true;
    return true;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async ensureConnected(): Promise<boolean> {
    this.calls.push("ensureConnected");
    return this.connected;
  }
  async disconnect(): Promise<void> {
    this.calls.push("disconnect");
    this.connected = false;
  }
  setSessionString(s: string): void {
    this.sessionString = s;
  }
  getSessionString(): string | undefined {
    return this.sessionString;
  }
}

/** Factory that yields the queued clients in order, then healthy ones forever. */
function makeManager(queue: object[]) {
  const created: object[] = [];
  const sm = new SessionManager(":memory:", () => {
    const next = queue.shift() ?? new HealthyTelegramService();
    created.push(next);
    return next as unknown as TelegramService;
  });
  return { sm, created };
}

describe("SessionManager — no permanent wedge (issue #19)", () => {
  it("a hung ensureConnected releases the per-user lock instead of pinning it forever", async () => {
    const wedged = new WedgeableTelegramService();
    const healthy = new HealthyTelegramService();
    const { sm } = makeManager([wedged, healthy]);
    sm.saveSessionString("user-A", "session-A");

    // Establish a healthy pooled session first — that is the state the bug starts from.
    assert.equal(await sm.getOrCreateSession("user-A"), wedged as unknown as TelegramService);
    wedged.wedge("dropped");

    const started = Date.now();
    // Now the socket is half-open: ensureConnected hangs, the deadline fires, the dead
    // client is discarded and rebuilt from the persisted session string in the same call.
    const second = await sm.getOrCreateSession("user-A");
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 5000, `getOrCreateSession took ${elapsed}ms — the lock was pinned`);
    assert.ok(wedged.calls.includes("ensureConnected"), "the reconnect attempt must have been made");
    assert.ok(wedged.calls.includes("disconnect"), "dead client must be torn down");
    assert.equal(second, healthy as unknown as TelegramService, "caller must get the rebuilt client");
  });

  it("a second call for the same user is not stuck behind the first one", async () => {
    // This is the user-visible half of the bug: not "one slow call" but "every call after
    // it, forever".
    const wedged = new WedgeableTelegramService();
    const { sm } = makeManager([wedged]);
    sm.saveSessionString("user-B", "session-B");
    await sm.getOrCreateSession("user-B");
    wedged.wedge("dropped");

    const started = Date.now();
    const first = sm.getOrCreateSession("user-B");
    const second = sm.getOrCreateSession("user-B");
    await Promise.all([first, second]);

    assert.ok(Date.now() - started < 5000, "the queue behind the wedged call never drained");
  });

  it("rebuilding preserves the persisted session string (no re-login)", async () => {
    const wedged = new WedgeableTelegramService();
    const healthy = new HealthyTelegramService();
    const { sm } = makeManager([wedged, healthy]);
    sm.saveSessionString("user-C", "session-C");
    await sm.getOrCreateSession("user-C");
    wedged.wedge("dropped");

    await sm.getOrCreateSession("user-C");

    // The whole point of a memory-only rebuild: same auth key, user sees nothing.
    assert.equal(healthy.getSessionString(), "session-C");
    assert.ok(sm.getSavedUserIds().includes("user-C"), "session row must survive the rebuild");
  });

  it("a connect() that never settles does not pin the lock either", async () => {
    const { sm } = makeManager([new WedgeableTelegramService(true)]);
    sm.saveSessionString("user-D", "session-D");
    const started = Date.now();
    // No pooled entry: goes straight to the build-from-SQLite path, whose connect() hangs.
    await sm.getOrCreateSession("user-D");
    assert.ok(Date.now() - started < 5000, "connect deadline did not fire");
    // Connect failed, so nothing broken was cached.
    assert.equal(sm.getSession("user-D"), undefined);
  });
});

describe("SessionManager.markUnhealthy (issue #19)", () => {
  it("drops the pooled client but keeps the persisted session", async () => {
    const healthy = new HealthyTelegramService();
    const { sm } = makeManager([healthy]);
    sm.saveSessionString("user-E", "session-E");

    await sm.getOrCreateSession("user-E");
    assert.ok(sm.getSession("user-E"), "precondition: session is pooled");

    sm.markUnhealthy("user-E");

    assert.equal(sm.getSession("user-E"), undefined, "in-memory client must be gone");
    assert.ok(sm.getSavedUserIds().includes("user-E"), "session_string must NOT be deleted");
    assert.ok(healthy.calls.includes("disconnect"), "old client should be torn down");
  });

  it("handles a sticky-connected half-open client: timeout → markUnhealthy → next call rebuilds", async () => {
    // isConnected() lies (returns true), so no reconnect is attempted and the hang happens
    // inside the tool handler. The tool-level deadline calls markUnhealthy; the NEXT call
    // must then produce a working client.
    const wedged = new WedgeableTelegramService();
    const healthy = new HealthyTelegramService();
    const { sm } = makeManager([wedged, healthy]);
    sm.saveSessionString("user-F", "session-F");

    await sm.getOrCreateSession("user-F");
    wedged.wedge("sticky");
    const first = await sm.getOrCreateSession("user-F");
    assert.equal(first, wedged as unknown as TelegramService, "sticky flag means it is handed out as-is");

    sm.markUnhealthy("user-F");
    const second = await sm.getOrCreateSession("user-F");

    assert.equal(second, healthy as unknown as TelegramService, "next call must get a fresh client");
    assert.equal(healthy.getSessionString(), "session-F");
  });

  it("is a no-op for a user with no pooled session", () => {
    const { sm } = makeManager([]);
    assert.doesNotThrow(() => sm.markUnhealthy("nobody"));
  });
});
