import type { AntigravitySettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import type { AntigravityInstallationError } from "./AntigravityInstallation.ts";

const CLI_WINDOW = /^(Five Hour|Weekly) Limit Remaining$/;
const PERCENT = /^(\d{1,3}(?:\.\d+)?)%$/;
const NETWORK_ENV =
  /^(PATH|LANG|LC_[A-Z_]+|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i;

export function parseAntigravityCliQuota(stdout: string): ServerProviderUsageWindow[] {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const line of stdout.trim().split(/\r?\n/)) {
    const [group, interval, remaining, reset, ...extra] = line.split("\t");
    const window = interval?.match(CLI_WINDOW)?.[1];
    const percent = remaining?.match(PERCENT)?.[1];
    if (!group || !window || percent === undefined || !reset || extra.length > 0) continue;
    const left = Number(percent);
    const resetsAt = Date.parse(reset);
    if (left > 100 || !Number.isFinite(resetsAt)) continue;
    const weekly = window === "Weekly";
    const family =
      group === "Gemini Models"
        ? "gemini"
        : group === "Claude and GPT models"
          ? "3p"
          : group.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const id = `${family}-${weekly ? "weekly" : "5h"}`;
    windows.set(id, {
      id,
      kind: weekly ? "weekly" : "session",
      label: `${group} · ${weekly ? "Weekly" : "5-hour"}`,
      usedPercent: 100 - left,
      windowDurationMins: weekly ? 7 * 24 * 60 : 5 * 60,
      // The CLI uses Unix epoch when a quota window has no reset.
      ...(resetsAt > 0 ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAt)) } : {}),
    });
  }
  return [...windows.values()];
}

export const probeAntigravityCliQuota = Effect.fn("probeAntigravityCliQuota")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly executable: Effect.Effect<string, AntigravityInstallationError, Scope.Scope>;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (input.authMethod !== "oauth-personal" || (yield* HostProcess.Platform) !== "linux") {
    return unsupported;
  }
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const loginName = "antigravity-oauth-token";
    const loginPath = path.join(input.profileDirectory, "antigravity-acp", loginName);
    if (!(yield* fs.exists(loginPath))) return unsupported;

    const executable = yield* input.executable;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-usage-" });
    const cliDirectory = path.join(home, ".gemini", "antigravity-cli");
    const loginTarget = path.join(cliDirectory, loginName);
    yield* fs.makeDirectory(cliDirectory, { recursive: true });
    yield* fs.writeFileString(loginTarget, "", { mode: 0o600 });
    yield* fs.writeFileString(
      path.join(cliDirectory, "settings.json"),
      '{"auth":{"type":"oauth-personal"}}\n',
    );
    const env = Object.fromEntries(
      Object.entries(input.environment).filter(([key]) => NETWORK_ENV.test(key)),
    );

    // The standalone CLI has its own home layout. Give it only this instance's
    // login and an isolated writable home, leaving the active ACP state untouched.
    const command = ChildProcess.make(
      "bwrap",
      [
        "--die-with-parent",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        home,
        home,
        "--ro-bind",
        loginPath,
        loginTarget,
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--chdir",
        home,
        "--",
        executable,
        "--print",
        "/usage",
        "--output-format",
        "text",
        "--print-timeout",
        "15s",
      ],
      {
        cwd: home,
        stdin: "ignore",
        extendEnv: false,
        env: {
          ...env,
          HOME: home,
          TMPDIR: home,
          TERM: "dumb",
          SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
          AGY_CLI_DISABLE_AUTO_UPDATE: "true",
          BROWSER: "/bin/false",
        },
      },
    );
    const result = yield* spawnAndCollect("bwrap", command, { maxStdoutBytes: 32 * 1024 });
    const windows = result.code === 0 ? parseAntigravityCliQuota(result.stdout) : [];
    return windows.length > 0
      ? makeUsageLimits({ checkedAt, windows })
      : makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Antigravity CLI could not read account quota.",
        });
  }).pipe(
    Effect.scoped,
    Effect.timeout("25 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity CLI quota needs a working bubblewrap and a valid instance sign-in.",
      }),
    ),
  );
});
