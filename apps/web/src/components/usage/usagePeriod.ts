// @effect-diagnostics globalDate:off -- Usage periods resolve against wall-clock "now" in the viewer's zone.
import {
  ProviderDriverKind,
  TrimmedNonEmptyString,
  UsageDay,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { collectLimitAccounts, type LimitPresentations } from "@t3tools/shared/usageLimits";
import { makeDayRangeWindow, makeInstantWindow, makeWindow } from "@t3tools/shared/usageFormat";
import * as Schema from "effect/Schema";

import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

export const UsagePresetDays = Schema.Literals([1, 7, 30, 90]);
export type UsagePresetDays = typeof UsagePresetDays.Type;

/** A cycle names a limit window, not instants, so it follows the window across resets. */
export const UsagePeriod = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("preset"), days: UsagePresetDays }),
  Schema.Struct({ kind: Schema.Literal("custom"), sinceDay: UsageDay, untilDay: UsageDay }),
  Schema.Struct({
    kind: Schema.Literal("cycle"),
    driver: ProviderDriverKind,
    windowId: TrimmedNonEmptyString,
    accountKey: Schema.String,
    previous: Schema.Boolean,
  }),
]);
export type UsagePeriod = typeof UsagePeriod.Type;
export type UsageCyclePeriod = Extract<UsagePeriod, { readonly kind: "cycle" }>;

export interface UsageCycle {
  readonly driver: ProviderDriverKind;
  readonly provider: UsageProviderKind;
  readonly windowId: string;
  readonly windowLabel: string;
  readonly accountKey: string;
  /** Names the account only when one provider reports several. */
  readonly accountLabel: string | null;
  readonly startMs: number;
  readonly resetsAtMs: number;
  readonly durationMs: number;
}

const MINUTE_MS = 60_000;

function usageProviderForDriver(driver: ProviderDriverKind): UsageProviderKind | undefined {
  return PROVIDER_ORDER.find((provider) => PROVIDER_PRESENTATION[provider].driverKind === driver);
}

/**
 * Limit windows that report both their reset and their length. A reset already in the past means
 * the snapshot is stale, and the next cycle's start would be a guess, so those are left out.
 */
export function collectUsageCycles(
  presentations: LimitPresentations,
  now: number,
): readonly UsageCycle[] {
  const accounts = collectLimitAccounts(presentations);
  const accountsPerDriver = new Map<ProviderDriverKind, number>();
  for (const account of accounts) {
    accountsPerDriver.set(account.driver, (accountsPerDriver.get(account.driver) ?? 0) + 1);
  }
  return accounts.flatMap((account) => {
    const provider = usageProviderForDriver(account.driver);
    if (provider === undefined) return [];
    const shared = (accountsPerDriver.get(account.driver) ?? 0) > 1;
    return account.limits.windows.flatMap((window) => {
      const resetsAtMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
      const durationMs = (window.windowDurationMins ?? 0) * MINUTE_MS;
      if (!Number.isFinite(resetsAtMs) || durationMs <= 0 || resetsAtMs <= now) return [];
      return [
        {
          driver: account.driver,
          provider,
          windowId: window.id,
          windowLabel: window.label,
          accountKey: account.key,
          accountLabel: shared ? (account.email ?? account.displayName ?? account.key) : null,
          startMs: resetsAtMs - durationMs,
          resetsAtMs,
          durationMs,
        },
      ];
    });
  });
}

/**
 * Usage records carry no limit scope, so windows that reset together (Claude's weekly and its
 * Fable-only weekly) cover the same spend and need only one row.
 */
export function cycleSpanKey(cycle: UsageCycle): string {
  return [cycle.provider, cycle.accountKey, cycle.startMs, cycle.durationMs].join("\u0000");
}

export function distinctCycleSpans(cycles: readonly UsageCycle[]): readonly UsageCycle[] {
  const seen = new Set<string>();
  return cycles.filter((cycle) => {
    const key = cycleSpanKey(cycle);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function cyclePeriod(cycle: UsageCycle, previous: boolean): UsageCyclePeriod {
  return {
    kind: "cycle",
    driver: cycle.driver,
    windowId: TrimmedNonEmptyString.make(cycle.windowId),
    accountKey: cycle.accountKey,
    previous,
  };
}

export function findUsageCycle(
  period: UsageCyclePeriod,
  cycles: readonly UsageCycle[],
): UsageCycle | undefined {
  return cycles.find(
    (cycle) =>
      cycle.driver === period.driver &&
      cycle.windowId === period.windowId &&
      cycle.accountKey === period.accountKey,
  );
}

/** The instants a cycle period covers; the current cycle stops at now. */
function cycleBounds(
  cycle: UsageCycle,
  previous: boolean,
  now: number,
): { readonly sinceMs: number; readonly untilMs: number } {
  if (previous) return { sinceMs: cycle.startMs - cycle.durationMs, untilMs: cycle.startMs };
  const untilMs = Math.min(cycle.resetsAtMs, Math.floor(now / MINUTE_MS) * MINUTE_MS);
  // Right after a reset the cycle is shorter than a minute; the server needs a nonempty span.
  return { sinceMs: cycle.startMs, untilMs: Math.max(untilMs, cycle.startMs + MINUTE_MS) };
}

/** Returns null for a cycle the selected environments no longer report. */
export function resolveUsagePeriod(
  period: UsagePeriod,
  cycles: readonly UsageCycle[],
  now: Date,
): UsageSummaryInput | null {
  switch (period.kind) {
    case "preset":
      return makeWindow(period.days, now, period.days === 1 ? "hour" : "day");
    case "custom":
      return makeDayRangeWindow(period.sinceDay, period.untilDay);
    case "cycle": {
      const cycle = findUsageCycle(period, cycles);
      if (cycle === undefined) return null;
      const { sinceMs, untilMs } = cycleBounds(cycle, period.previous, now.getTime());
      return makeInstantWindow(sinceMs, untilMs);
    }
  }
}

/** Identifies the instants a cycle period resolves to, so a reset can re-resolve it. */
export function cycleResolutionKey(
  period: UsagePeriod,
  cycles: readonly UsageCycle[],
): string | null {
  if (period.kind !== "cycle") return null;
  const cycle = findUsageCycle(period, cycles);
  return cycle === undefined ? "missing" : `${cycle.startMs}:${cycle.durationMs}`;
}

export function onlyProvider(provider: UsageProviderKind): readonly UsageProviderKind[] {
  return PROVIDER_ORDER.filter((candidate) => candidate !== provider);
}

/** Days in the viewer's zone, which is the zone the calendar shows. */
export function localUsageDay(date: Date): UsageDay {
  const pad = (value: number) => String(value).padStart(2, "0");
  return UsageDay.make(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
}

export function usageDayToLocalDate(day: string): Date {
  const [year = 0, month = 1, dayOfMonth = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, dayOfMonth);
}
