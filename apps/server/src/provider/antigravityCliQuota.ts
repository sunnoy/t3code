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

type QuotaSandboxPlatform = "linux" | "darwin";

const isQuotaSandboxPlatform = (platform: NodeJS.Platform): platform is QuotaSandboxPlatform =>
  platform === "linux" || platform === "darwin";

// Seatbelt matches resolved paths, so HOME_DIR must be the temp home's real path
// (/private/var/folders/... rather than /var/folders/...).
const MACOS_QUOTA_SANDBOX_PROFILE = [
  "(version 1)",
  "(allow default)",
  "(deny file-write*)",
  '(allow file-write* (subpath (param "HOME_DIR")) (subpath "/dev"))',
].join("\n");

/**
 * The command that runs the standalone CLI with writes confined to `home`.
 * Linux mounts the instance login read-only over an empty file. macOS has no
 * bind mounts: `home` holds a symlink to the login, and the sandbox denies the
 * write through it, so a token refresh cannot touch the active ACP sign-in.
 */
export function antigravityQuotaSandboxCommand(input: {
  readonly platform: QuotaSandboxPlatform;
  readonly home: string;
  readonly loginPath: string;
  readonly loginTarget: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}): { readonly command: string; readonly args: ReadonlyArray<string> } {
  if (input.platform === "darwin") {
    return {
      command: "/usr/bin/sandbox-exec",
      args: [
        "-D",
        `HOME_DIR=${input.home}`,
        "-p",
        MACOS_QUOTA_SANDBOX_PROFILE,
        input.executable,
        ...input.args,
      ],
    };
  }
  return {
    command: "bwrap",
    args: [
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      input.home,
      input.home,
      "--ro-bind",
      input.loginPath,
      input.loginTarget,
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--chdir",
      input.home,
      "--",
      input.executable,
      ...input.args,
    ],
  };
}

export const probeAntigravityCliQuota = Effect.fn("probeAntigravityCliQuota")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly executable: Effect.Effect<string, AntigravityInstallationError, Scope.Scope>;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  const platform = yield* HostProcess.Platform;
  if (input.authMethod !== "oauth-personal" || !isQuotaSandboxPlatform(platform)) {
    return unsupported;
  }
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const loginName = "antigravity-oauth-token";
    const loginPath = path.join(input.profileDirectory, "antigravity-acp", loginName);
    if (!(yield* fs.exists(loginPath))) return unsupported;

    const executable = yield* input.executable;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-usage-" }));
    const cliDirectory = path.join(home, ".gemini", "antigravity-cli");
    const loginTarget = path.join(cliDirectory, loginName);
    yield* fs.makeDirectory(cliDirectory, { recursive: true });
    if (platform === "darwin") {
      yield* fs.symlink(yield* fs.realPath(loginPath), loginTarget);
    } else {
      yield* fs.writeFileString(loginTarget, "", { mode: 0o600 });
    }
    yield* fs.writeFileString(
      path.join(cliDirectory, "settings.json"),
      '{"auth":{"type":"oauth-personal"}}\n',
    );
    const env = Object.fromEntries(
      Object.entries(input.environment).filter(([key]) => NETWORK_ENV.test(key)),
    );

    // The standalone CLI has its own home layout. Give it only this instance's
    // login and an isolated writable home, leaving the active ACP state untouched.
    const sandbox = antigravityQuotaSandboxCommand({
      platform,
      home,
      loginPath,
      loginTarget,
      executable,
      args: ["--print", "/usage", "--output-format", "text", "--print-timeout", "15s"],
    });
    const command = ChildProcess.make(sandbox.command, [...sandbox.args], {
      cwd: home,
      stdin: "ignore",
      extendEnv: false,
      env: {
        ...env,
        HOME: home,
        TMPDIR: home,
        TERM: "dumb",
        // agy keeps Google sign-ins in the OS keyring unless it believes it runs over SSH.
        SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        BROWSER: "/bin/false",
      },
    });
    const result = yield* spawnAndCollect(sandbox.command, command, {
      maxStdoutBytes: 32 * 1024,
    });
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
        message:
          platform === "darwin"
            ? "Antigravity CLI quota needs a working sandbox-exec and a valid instance sign-in."
            : "Antigravity CLI quota needs a working bubblewrap and a valid instance sign-in.",
      }),
    ),
  );
});
