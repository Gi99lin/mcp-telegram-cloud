/**
 * issue #19 guard — every await that reaches GramJS must be bounded.
 *
 * The behavioural tests prove today's paths are bounded. This one is about tomorrow: the
 * bug was not a wrong line of code, it was an easy-to-add one. A new `await
 * telegram.ensureConnected()` inside `SessionManager` re-pins the per-user lock and
 * resurrects the exact wedge users reported, while every existing test stays green.
 *
 * Source-level on purpose: there is no runtime seam that can observe "someone awaited the
 * network without a deadline". Renaming the import does not defeat it, because it matches
 * the Telegram call sites, not the deadline helper.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files that own a Telegram connection lifecycle. */
const GUARDED_FILES = ["session-manager.ts", "mcp-handler.ts", "tool-registry.ts"];

/** Calls that put us on the wire and can therefore hang on a half-open socket. */
const WIRE_CALLS = /\.(ensureConnected|connect)\(\s*\)/;

/** Markers that make a call site bounded. */
const BOUNDED = /withDeadline|connectBounded/;

/** Lines that are comments — prose mentioning `ensureConnected()` is not a call site. */
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

describe("no unbounded Telegram await (issue #19 guard)", () => {
  for (const file of GUARDED_FILES) {
    it(`${file}: every ensureConnected/connect call sits inside a deadline`, () => {
      const lines = readFileSync(join(SRC, file), "utf8").split("\n");
      const offenders: string[] = [];

      lines.forEach((line, i) => {
        if (COMMENT.test(line)) return;
        if (!WIRE_CALLS.test(line)) return;
        // A deadline wrapper is either on this line or opens a few lines above:
        //   await withDeadline("ensureConnected", budget, () =>
        //     pooled.telegram.ensureConnected(),
        //   );
        const window = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
        if (BOUNDED.test(window)) return;
        // Teardown is fire-and-forget by design and cannot pin a caller.
        if (/\.disconnect\(\)/.test(line)) return;
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });

      assert.deepEqual(
        offenders,
        [],
        `Unbounded Telegram await(s) found. Wrap them in withDeadline(…, config.telegramConnectTimeoutMs, …) ` +
          `or route them through SessionManager.connectBounded — an unbounded one pins the per-user lock forever (issue #19):\n` +
          offenders.join("\n"),
      );
    });
  }

  it("the guard actually matches real call sites (it is not a no-op regex)", () => {
    // If a refactor renamed these methods, the loop above would pass vacuously.
    const source = readFileSync(join(SRC, "session-manager.ts"), "utf8");
    const hits = source.split("\n").filter((l) => !COMMENT.test(l) && WIRE_CALLS.test(l));
    assert.ok(hits.length >= 3, `expected the guard to see several wire calls, saw ${hits.length}`);
  });

  it("tool handlers are invoked through a deadline in the registry", () => {
    const source = readFileSync(join(SRC, "tool-registry.ts"), "utf8");
    const handlerCalls = source.split("\n").filter((l) => !COMMENT.test(l) && /tool\.handler\(/.test(l));
    assert.equal(handlerCalls.length, 1, "expected exactly one tool.handler call site in the registry");
    assert.match(
      source,
      /withDeadline\(`tool:\$\{tool\.name\}`[\s\S]{0,120}tool\.handler\(/,
      "the single tool.handler call site must be wrapped in withDeadline",
    );
  });
});
