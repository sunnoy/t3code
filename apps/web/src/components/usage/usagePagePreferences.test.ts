import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind, TrimmedNonEmptyString, UsageDay } from "@t3tools/contracts";

import { readUsagePagePreferences, saveUsagePagePreferences } from "./usagePagePreferences";

const key = "t3code:usage-page-preferences:v2";
const DEFAULTS = { metric: "limits", period: { kind: "preset", days: 30 } };
let values: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem">;

beforeEach(() => {
  values = new Map();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Usage page preferences", () => {
  it("round-trips hidden providers and reads saves without them", () => {
    saveUsagePagePreferences({
      metric: "cost",
      period: { kind: "preset", days: 7 },
      hiddenProviders: ["codex"],
    });
    expect(readUsagePagePreferences().hiddenProviders).toEqual(["codex"]);

    values.set(key, '{"metric":"tokens","period":{"kind":"preset","days":30}}');
    expect(readUsagePagePreferences()).toEqual({
      metric: "tokens",
      period: { kind: "preset", days: 30 },
    });
  });

  it("round-trips custom ranges and cycles", () => {
    const custom = {
      kind: "custom",
      sinceDay: UsageDay.make("2026-08-01"),
      untilDay: UsageDay.make("2026-08-15"),
    } as const;
    saveUsagePagePreferences({ metric: "cost", period: custom });
    expect(readUsagePagePreferences().period).toEqual(custom);

    const cycle = {
      kind: "cycle",
      driver: ProviderDriverKind.make("codex"),
      windowId: TrimmedNonEmptyString.make("secondary"),
      accountKey: "codex:account",
      previous: true,
    } as const;
    saveUsagePagePreferences({ metric: "cost", period: cycle });
    expect(readUsagePagePreferences().period).toEqual(cycle);
  });

  // regression: #10189 an invalid saved usage selection was never replaced
  it.each([
    "not-json",
    '{"metric":"unknown","period":{"kind":"preset","days":7}}',
    '{"metric":"cost","period":{"kind":"preset","days":365}}',
    '{"metric":"cost","windowDays":7}',
  ])("replaces invalid preferences on the next save: %s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual(DEFAULTS);
    saveUsagePagePreferences({ metric: "tokens", period: { kind: "preset", days: 7 } });
    expect(readUsagePagePreferences()).toEqual({
      metric: "tokens",
      period: { kind: "preset", days: 7 },
    });
  });
});
