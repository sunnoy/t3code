// @effect-diagnostics globalDate:off -- Cycle ranges and the calendar are wall-clock dates in the viewer's zone.
import type { DateRange } from "@daypicker/react";
import { formatDateTimeShort, formatDayShort } from "@t3tools/shared/usageFormat";
import { useGT, useLocale, useMessages } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveHour12 } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Calendar } from "../ui/calendar";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  cyclePeriod,
  cycleSpanKey,
  distinctCycleSpans,
  findUsageCycle,
  localUsageDay,
  type UsageCycle,
  type UsagePeriod,
  usageDayToLocalDate,
} from "./usagePeriod";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { WINDOW_OPTIONS } from "./usageShortcuts";

type PresetOption = (typeof WINDOW_OPTIONS)[number];

function samePeriod(left: UsagePeriod, right: UsagePeriod): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cycleName(cycle: UsageCycle): string {
  const parts = [PROVIDER_PRESENTATION[cycle.provider].label, cycle.windowLabel];
  if (cycle.accountLabel !== null) parts.push(cycle.accountLabel);
  return parts.join(" · ");
}

function useUsagePeriodLabel(period: UsagePeriod, cycles: readonly UsageCycle[]): string {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  switch (period.kind) {
    case "preset": {
      const option = WINDOW_OPTIONS.find((candidate) => candidate.days === period.days);
      return option ? m(option.label) : String(period.days);
    }
    case "custom":
      return gt("{start} to {end}", {
        start: formatDayShort(period.sinceDay, locale),
        end: formatDayShort(period.untilDay, locale),
      });
    case "cycle": {
      const cycle = findUsageCycle(period, cycles);
      if (cycle === undefined) return gt("Cycle unavailable");
      const name = cycleName(cycle);
      return period.previous
        ? gt("{name}: previous cycle", { name })
        : gt("{name}: this cycle", { name });
    }
  }
}

export function UsagePeriodPicker({
  period,
  cycles,
  compact,
  rangeLabel,
  presetTitle,
  onSelect,
}: {
  readonly period: UsagePeriod;
  readonly cycles: readonly UsageCycle[];
  /** Narrow headers fold the presets into the popover instead of a segmented control. */
  readonly compact: boolean;
  /** The exact span being shown; the header hides it below its widest breakpoint. */
  readonly rangeLabel: string;
  readonly presetTitle: (option: PresetOption) => string;
  readonly onSelect: (period: UsagePeriod) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const label = useUsagePeriodLabel(period, cycles);
  const [open, setOpen] = useState(false);
  const select = (next: UsagePeriod) => {
    setOpen(false);
    onSelect(next);
  };
  const menu = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size={compact || period.kind !== "preset" ? "compact" : "icon-sm"}
            aria-label={gt("More usage periods")}
            title={rangeLabel}
            className="max-w-72 min-w-0"
          />
        }
      >
        {compact || period.kind !== "preset" ? <span className="truncate">{label}</span> : null}
        <ChevronDownIcon className="size-4 shrink-0 opacity-72" />
      </PopoverTrigger>
      <PopoverPopup align="end" aria-label={gt("Usage period")}>
        <UsagePeriodMenu
          period={period}
          cycles={cycles}
          presets={compact ? WINDOW_OPTIONS : []}
          onSelect={select}
        />
      </PopoverPopup>
    </Popover>
  );
  if (compact) return menu;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ToggleGroup
        aria-label={gt("Usage period")}
        variant="segmented"
        value={period.kind === "preset" ? [String(period.days)] : []}
        onValueChange={(next) => {
          const option = WINDOW_OPTIONS.find((candidate) => String(candidate.days) === next[0]);
          if (option) onSelect({ kind: "preset", days: option.days });
        }}
      >
        {WINDOW_OPTIONS.map((option) => (
          <Toggle key={option.days} value={String(option.days)} title={presetTitle(option)}>
            {m(option.label)}
          </Toggle>
        ))}
      </ToggleGroup>
      {menu}
    </div>
  );
}

function UsagePeriodMenu({
  period,
  cycles,
  presets,
  onSelect,
}: {
  readonly period: UsagePeriod;
  readonly cycles: readonly UsageCycle[];
  readonly presets: readonly PresetOption[];
  readonly onSelect: (period: UsagePeriod) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const [range, setRange] = useState<DateRange | undefined>(() =>
    period.kind === "custom"
      ? { from: usageDayToLocalDate(period.sinceDay), to: usageDayToLocalDate(period.untilDay) }
      : undefined,
  );
  const [today] = useState(() => new Date());
  const instant = (ms: number) =>
    formatDateTimeShort(new Date(ms).toISOString(), undefined, hour12, locale);
  const selectedCycle = period.kind === "cycle" ? findUsageCycle(period, cycles) : undefined;
  // A selection made from a merged row's twin (the Limits card) still marks the shared row.
  const cycleActive = (cycle: UsageCycle, previous: boolean) =>
    period.kind === "cycle" &&
    period.previous === previous &&
    selectedCycle !== undefined &&
    cycleSpanKey(selectedCycle) === cycleSpanKey(cycle);
  const option = (
    key: string,
    next: UsagePeriod,
    title: string,
    detail?: string,
    active = samePeriod(period, next),
  ) => (
    <Button
      key={key}
      variant={active ? "secondary" : "ghost"}
      size="compact"
      className="w-full justify-between"
      onClick={() => onSelect(next)}
    >
      <span>{title}</span>
      {detail ? (
        <span className="ms-3 truncate text-xs text-muted-foreground tabular-nums">{detail}</span>
      ) : null}
    </Button>
  );
  const heading = (text: string) => (
    <h3 className="px-1 text-xs font-medium text-muted-foreground">{text}</h3>
  );

  return (
    <div className="flex w-76 flex-col gap-4">
      {presets.length > 0 ? (
        <section className="flex flex-col gap-1">
          {heading(gt("Recent"))}
          {presets.map((preset) =>
            option(String(preset.days), { kind: "preset", days: preset.days }, m(preset.label)),
          )}
        </section>
      ) : null}
      <section className="flex flex-col gap-1">
        {heading(gt("Subscription cycles"))}
        {cycles.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            {gt("No provider on the selected environments reports a reset cycle.")}
          </p>
        ) : (
          distinctCycleSpans(cycles).map((cycle) => (
            <div key={`${cycle.accountKey}:${cycle.windowId}`} className="flex flex-col gap-0.5">
              <span className="px-1 text-sm font-medium text-foreground">{cycleName(cycle)}</span>
              {option(
                "current",
                cyclePeriod(cycle, false),
                gt("This cycle"),
                gt("{start} to {end}", {
                  start: instant(cycle.startMs),
                  end: instant(cycle.resetsAtMs),
                }),
                cycleActive(cycle, false),
              )}
              {option(
                "previous",
                cyclePeriod(cycle, true),
                gt("Previous cycle"),
                gt("{start} to {end}", {
                  start: instant(cycle.startMs - cycle.durationMs),
                  end: instant(cycle.startMs),
                }),
                cycleActive(cycle, true),
              )}
            </div>
          ))
        )}
      </section>
      <section className="flex flex-col gap-1">
        {heading(gt("Custom range"))}
        <Calendar
          mode="range"
          selected={range}
          onSelect={setRange}
          defaultMonth={range?.from ?? today}
          disabled={{ after: today }}
        />
        <Button
          size="compact"
          disabled={range?.from === undefined}
          onClick={() => {
            if (range?.from === undefined) return;
            onSelect({
              kind: "custom",
              sinceDay: localUsageDay(range.from),
              untilDay: localUsageDay(range.to ?? range.from),
            });
          }}
        >
          {gt("Show range")}
        </Button>
      </section>
    </div>
  );
}
