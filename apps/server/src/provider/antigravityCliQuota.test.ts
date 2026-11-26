import { it as effectIt } from "@effect/vitest";
import type { PtyProcess } from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import {
  antigravityQuotaSandboxCommand,
  makeAntigravityQuotaRefresh,
  parseAntigravityCliQuota,
  readAntigravityQuotaTerminal,
} from "./antigravityCliQuota.ts";

const now = Date.parse("2026-11-26T06:00:00Z");
const report = [
  "└ Models & Quota",
  "GEMINI MODELS",
  "  Weekly Limit Remaining",
  "    [████░] 79%",
  "    Refreshes in 4d 17h 22m",
  "  Five Hour Limit Remaining",
  "    [████░] 82%",
  "    Refreshes in 23m",
  "CLAUDE AND GPT MODELS",
  "  Weekly Limit Remaining",
  "    [█████] 100.00%",
  "    Quota available",
  "  Five Hour Limit Remaining",
  "    [█████] 100%",
  "    Quota available",
  "  ↑/↓ Scroll · esc Close",
];

describe("Antigravity CLI quota report", () => {
  effectIt.effect(
    "keeps five minutes between attempts, including failed or cancelled attempts",
    () =>
      Effect.gen(function* () {
        const attempts = yield* Queue.unbounded<void>();
        const quota = yield* makeAntigravityQuotaRefresh(
          Queue.offer(attempts, undefined).pipe(
            Effect.as({
              checkedAt: "2026-11-26T06:00:00.000Z",
              windows: [],
              unavailable: { reason: "probeFailed" as const },
            }),
          ),
          () => Effect.void,
        );
        yield* quota.refresh;
        yield* Queue.take(attempts);
        yield* quota.cancel;
        yield* TestClock.adjust("4 minutes");
        yield* quota.refresh;
        yield* TestClock.adjust("59 seconds");
        yield* quota.refresh;
        yield* Effect.yieldNow;
        expect(yield* Queue.size(attempts)).toBe(0);
        yield* TestClock.adjust("1 second");
        yield* quota.refresh;
        yield* Queue.take(attempts);
      }),
  );

  it("reads both model groups and converts displayed reset durations", () => {
    const windows = parseAntigravityCliQuota(report.join("\n"), now);
    expect(
      windows.map(({ id, usedPercent, resetsAt, windowDurationMins }) => ({
        id,
        usedPercent,
        resetsAt,
        windowDurationMins,
      })),
    ).toEqual([
      {
        id: "gemini-weekly",
        usedPercent: 21,
        resetsAt: "2026-11-30T23:22:00.000Z",
        windowDurationMins: 10_080,
      },
      {
        id: "gemini-5h",
        usedPercent: 18,
        resetsAt: "2026-11-26T06:23:00.000Z",
        windowDurationMins: 300,
      },
      { id: "3p-weekly", usedPercent: 0, resetsAt: undefined, windowDurationMins: 10_080 },
      { id: "3p-5h", usedPercent: 0, resetsAt: undefined, windowDurationMins: 300 },
    ]);
  });

  it("ignores unrelated output and invalid quota rows", () => {
    expect(parseAntigravityCliQuota("Authentication required", now)).toEqual([]);
    expect(
      parseAntigravityCliQuota(
        ["Models & Quota", "GEMINI MODELS", "Weekly Limit Remaining", "[█████] 101%"].join("\n"),
        now,
      ),
    ).toEqual([]);
  });

  effectIt.effect("waits for the prompt and for the quota panel to load", () =>
    Effect.gen(function* () {
      let receive: (data: string) => void = () => {};
      const writes: string[] = [];
      const terminal: PtyProcess = {
        pid: 1,
        write: (data) => {
          writes.push(String(data));
        },
        resize: () => {},
        kill: () => {},
        onData: (listener) => {
          receive = listener;
          return () => {
            receive = () => {};
          };
        },
        onExit: () => () => {},
      };
      const result = yield* readAntigravityQuotaTerminal(terminal, () => now).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      receive("Signing in...");
      expect(writes).toEqual([]);
      receive("\u001b[2J\u001b[1;1H? for short");
      receive("cuts\r\n");
      expect(writes).toEqual(["/usage\r"]);
      receive("\u001b[2J\u001b[H└ Models & Quota\r\nLoading...\r\n  ↑/↓ Scroll · esc Close");
      receive("\u001b[2J\u001b[H" + report.slice(0, -1).join("\r\n"));
      receive("\r\n" + report.at(-1));
      expect(yield* Fiber.join(result)).toHaveLength(4);
    }),
  );

  const sandboxInput = {
    home: "/private/var/folders/t3/t3-agy-usage-1",
    workspace: "/private/var/folders/t3/t3-agy-usage-1/workspace",
    loginPath: "/state/antigravity-acp/antigravity-oauth-token",
    loginTarget:
      "/private/var/folders/t3/t3-agy-usage-1/.gemini/antigravity-cli/antigravity-oauth-token",
    executable: "/managed/agy",
  };

  it("confines the macOS CLI's writes to its temp home with sandbox-exec", () => {
    const { command, args } = antigravityQuotaSandboxCommand({
      ...sandboxInput,
      platform: "darwin",
    });
    expect(command).toBe("/usr/bin/sandbox-exec");
    expect(args.slice(0, 2)).toEqual(["-D", `HOME_DIR=${sandboxInput.home}`]);
    expect(args[3]).toContain("(deny file-write*)");
    expect(args[3]).toContain('(subpath (param "HOME_DIR"))');
    expect(args.slice(4)).toEqual(["/managed/agy"]);
  });

  it("mounts the Linux login read-only inside bubblewrap", () => {
    const { command, args } = antigravityQuotaSandboxCommand({
      ...sandboxInput,
      platform: "linux",
    });
    expect(command).toBe("bwrap");
    const login = args.indexOf(sandboxInput.loginPath);
    expect(args.slice(login - 1, login + 2)).toEqual([
      "--ro-bind",
      sandboxInput.loginPath,
      sandboxInput.loginTarget,
    ]);
    expect(args[args.indexOf("--chdir") + 1]).toBe(sandboxInput.workspace);
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["/managed/agy"]);
  });
});
