import { describe, expect, it } from "vite-plus/test";
import { parseAntigravityCliQuota } from "./antigravityCliQuota.ts";

describe("Antigravity CLI quota report", () => {
  it("reads subscription windows and omits the CLI's no-reset sentinel", () => {
    const windows = parseAntigravityCliQuota(
      [
        "Gemini Models\tWeekly Limit Remaining\t79%\t2026-11-30T23:22:27Z",
        "Gemini Models\tFive Hour Limit Remaining\t82%\t2026-11-26T06:23:10Z",
        "Claude and GPT models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z",
        "Claude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z",
      ].join("\n"),
    );
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
        resetsAt: "2026-11-30T23:22:27.000Z",
        windowDurationMins: 10_080,
      },
      {
        id: "gemini-5h",
        usedPercent: 18,
        resetsAt: "2026-11-26T06:23:10.000Z",
        windowDurationMins: 300,
      },
      { id: "3p-weekly", usedPercent: 0, resetsAt: undefined, windowDurationMins: 10_080 },
      { id: "3p-5h", usedPercent: 0, resetsAt: undefined, windowDurationMins: 300 },
    ]);
  });

  it("ignores authentication or diagnostic output and invalid quota rows", () => {
    expect(
      parseAntigravityCliQuota(
        [
          "Authentication required",
          "Gemini Models\tWeekly Limit Remaining\t101%\t2026-11-30T23:22:27Z",
          "Gemini Models\tFive Hour Limit Remaining\t80%\tinvalid",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
