import { describe, expect, it } from "vite-plus/test";
import { antigravityQuotaSandboxCommand, parseAntigravityCliQuota } from "./antigravityCliQuota.ts";

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

  const sandboxInput = {
    home: "/private/var/folders/t3/t3-agy-usage-1",
    loginPath: "/state/antigravity-acp/antigravity-oauth-token",
    loginTarget:
      "/private/var/folders/t3/t3-agy-usage-1/.gemini/antigravity-cli/antigravity-oauth-token",
    executable: "/managed/agy",
    args: ["--print", "/usage"],
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
    expect(args.slice(4)).toEqual(["/managed/agy", "--print", "/usage"]);
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
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["/managed/agy", "--print", "/usage"]);
  });
});
