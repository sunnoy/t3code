// @effect-diagnostics globalDate:off -- Fixed instants keep cycle bounds deterministic.
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  UsageDay,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectUsageCycles,
  cyclePeriod,
  resolveUsagePeriod,
  type UsageCycle,
} from "./usagePeriod";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const weekly: ServerProviderUsageWindow = {
  id: "secondary",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 40,
  windowDurationMins: 7 * 24 * 60,
  resetsAt: "2026-09-06T09:30:00.000Z",
};

function provider(
  driver: string,
  windows: readonly ServerProviderUsageWindow[],
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [...windows] },
    ...overrides,
  };
}

function presentations(providers: readonly ServerProvider[]) {
  return new Map([
    [
      EnvironmentId.make("local"),
      { entry: { target: { label: "Local" } }, serverConfig: { providers } },
    ],
  ]);
}

describe("collectUsageCycles", () => {
  it("derives each cycle's start from its reset and length", () => {
    const [cycle] = collectUsageCycles(presentations([provider("codex", [weekly])]), now);

    expect(cycle).toMatchObject({
      provider: "codex",
      windowId: "secondary",
      windowLabel: "Weekly",
      accountLabel: null,
      startMs: Date.parse("2026-08-30T09:30:00.000Z"),
      resetsAtMs: Date.parse("2026-09-06T09:30:00.000Z"),
    });
  });

  it("maps a driver to its usage provider", () => {
    const cycles = collectUsageCycles(
      presentations([provider("claudeAgent", [{ ...weekly, id: "seven_day", label: "Weekly" }])]),
      now,
    );

    expect(cycles.map((cycle) => cycle.provider)).toEqual(["claude"]);
  });

  it.each([
    ["no reset", { resetsAt: undefined }],
    ["no length", { windowDurationMins: undefined }],
    ["a reset already past", { resetsAt: "2026-09-03T11:59:00.000Z" }],
  ])("leaves out a window with %s", (_name, overrides) => {
    const window = { ...weekly, ...overrides } as ServerProviderUsageWindow;

    expect(collectUsageCycles(presentations([provider("codex", [window])]), now)).toEqual([]);
  });
});

describe("resolveUsagePeriod", () => {
  const cycle: UsageCycle = {
    driver: ProviderDriverKind.make("codex"),
    provider: "codex",
    windowId: "secondary",
    windowLabel: "Weekly",
    accountKey: "codex:account",
    accountLabel: null,
    startMs: Date.parse("2026-08-30T09:30:00.000Z"),
    resetsAtMs: Date.parse("2026-09-06T09:30:00.000Z"),
    durationMs: 7 * 24 * 60 * 60_000,
  };
  const session: UsageCycle = {
    ...cycle,
    windowId: "primary",
    windowLabel: "Session",
    startMs: Date.parse("2026-09-03T09:00:00.000Z"),
    resetsAtMs: Date.parse("2026-09-03T14:00:00.000Z"),
    durationMs: 5 * 60 * 60_000,
  };

  it("runs the current cycle from its start to now", () => {
    const window = resolveUsagePeriod(cyclePeriod(cycle, false), [cycle], new Date(now + 42_000));

    expect(window).toMatchObject({
      resolution: "day",
      sinceTime: "2026-08-30T09:30:00.000Z",
      untilTime: "2026-09-03T12:00:00.000Z",
    });
  });

  it("covers the whole previous cycle", () => {
    const window = resolveUsagePeriod(cyclePeriod(cycle, true), [cycle], new Date(now));

    expect(window).toMatchObject({
      sinceTime: "2026-08-23T09:30:00.000Z",
      untilTime: "2026-08-30T09:30:00.000Z",
    });
  });

  it("charts a session cycle by hour", () => {
    const window = resolveUsagePeriod(cyclePeriod(session, false), [session], new Date(now));

    expect(window).toMatchObject({
      resolution: "hour",
      sinceTime: "2026-09-03T09:00:00.000Z",
      untilTime: "2026-09-03T12:00:00.000Z",
    });
  });

  it("keeps a nonempty span right after a reset", () => {
    const fresh = { ...session, startMs: now, resetsAtMs: now + session.durationMs };
    const window = resolveUsagePeriod(cyclePeriod(fresh, false), [fresh], new Date(now + 5_000));

    expect(window?.untilTime).toBe("2026-09-03T12:01:00.000Z");
  });

  it("returns null for a cycle no environment reports", () => {
    expect(resolveUsagePeriod(cyclePeriod(cycle, false), [], new Date(now))).toBeNull();
  });

  it("keeps whole days for a custom range", () => {
    const window = resolveUsagePeriod(
      {
        kind: "custom",
        sinceDay: UsageDay.make("2026-08-01"),
        untilDay: UsageDay.make("2026-08-15"),
      },
      [],
      new Date(now),
    );

    expect(window).toMatchObject({
      sinceDay: "2026-08-01",
      untilDay: "2026-08-15",
      resolution: "day",
    });
    expect(window?.sinceTime).toBeUndefined();
  });
});
