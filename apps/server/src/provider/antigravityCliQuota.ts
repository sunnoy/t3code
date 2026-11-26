import * as NodeUtil from "node:util";
import type {
  AntigravitySettings,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { PtyAdapter, PtyProcess } from "@t3tools/shared/PtyAdapter";
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT } from "@t3tools/shared/terminalOutput";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { AntigravityInstallationError } from "./AntigravityInstallation.ts";

const CLI_WINDOW = /^(Five Hour|Weekly) Limit Remaining$/i;
const AUTH_REQUIRED =
  /\b(?:authentication required|sign in again|please (?:log|sign) in|invalid_grant|(?:access|refresh) token (?:has expired|is expired))\b/i;
const PERCENT = /^\[.*\]\s+(\d{1,3}(?:\.\d+)?)%$/;
const GROUPS = {
  "gemini models": { id: "gemini", label: "Gemini Models" },
  "claude and gpt models": { id: "3p", label: "Claude and GPT models" },
} as const;
const RESET_UNITS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 } as const;
const NETWORK_ENV =
  /^(PATH|LANG|LC_[A-Z_]+|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
const QUOTA_MIN_INTERVAL = Duration.toNanosUnsafe(Duration.minutes(5));
const encodeQuotaSettings = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      auth: Schema.Struct({ type: Schema.Literal("oauth-personal") }),
      trustedWorkspaces: Schema.Array(Schema.String),
    }),
  ),
);
const PublishingUsage = Context.Reference<boolean>("t3/provider/AntigravityPublishingUsage", {
  defaultValue: () => false,
});

export const makeAntigravityQuotaRefresh = Effect.fn("makeAntigravityQuotaRefresh")(function* (
  probe: Effect.Effect<ServerProviderUsageLimits> | undefined,
  apply: (limits: ServerProviderUsageLimits) => Effect.Effect<void>,
) {
  const active = yield* FiberHandle.make();
  const republish = yield* Deferred.make<Effect.Effect<ServerProvider>>();
  const scope = yield* Effect.scope;
  const publish = Deferred.await(republish).pipe(
    Effect.flatten,
    Effect.provideService(PublishingUsage, true),
  );
  let lastAttempt: bigint | undefined;
  return {
    refresh: Effect.gen(function* () {
      if (!probe || (yield* PublishingUsage)) return;
      yield* FiberHandle.run(
        active,
        Effect.gen(function* () {
          const now = yield* Clock.monotonicTimeNanos;
          if (lastAttempt !== undefined && now - lastAttempt < QUOTA_MIN_INTERVAL) return;
          // Record failed and cancelled attempts too. Every trigger shares this instance's slot.
          lastAttempt = now;
          yield* Effect.flatMap(probe, apply);
          yield* publish.pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));
        }),
        // Store the fiber before it starts so an account change can cancel it.
        { onlyIfMissing: true, startImmediately: false },
      );
    }),
    cancel: FiberHandle.clear(active),
    publish,
    setPublisher: (effect: Effect.Effect<ServerProvider>) => Deferred.succeed(republish, effect),
  };
});

function quotaResetAt(line: string, now: number): string | undefined {
  const duration = line.match(/^Refreshes in <?((?:\d+[dhms]\s*)+)$/)?.[1];
  if (!duration) return undefined;
  let milliseconds = 0;
  for (const match of duration.matchAll(/(\d+)([dhms])/g)) {
    milliseconds += Number(match[1]) * RESET_UNITS[match[2] as keyof typeof RESET_UNITS];
  }
  const reset = DateTime.make(now + milliseconds);
  return reset._tag === "Some" ? DateTime.formatIso(reset.value) : undefined;
}

export function parseAntigravityCliQuota(screen: string, now: number): ServerProviderUsageWindow[] {
  const lines = screen.split("\n").map((line) => line.trim());
  const heading = lines.findLastIndex((line) =>
    /^(?:└\s+)?(?:Models & Quota|Quota & Credits)$/i.test(line),
  );
  if (heading === -1) return [];
  const windows = new Map<string, ServerProviderUsageWindow>();
  let group: (typeof GROUPS)[keyof typeof GROUPS] | undefined;
  for (let index = heading + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const groupName = line.toLowerCase();
    if (Object.hasOwn(GROUPS, groupName)) {
      group = GROUPS[groupName as keyof typeof GROUPS];
      continue;
    }
    const window = line.match(CLI_WINDOW)?.[1];
    const percent = lines[index + 1]?.match(PERCENT)?.[1];
    if (!group || !window || percent === undefined) continue;
    const left = Number(percent);
    if (left > 100) continue;
    const resetsAt = quotaResetAt(lines[index + 2] ?? "", now);
    const weekly = window.toLowerCase() === "weekly";
    const id = `${group.id}-${weekly ? "weekly" : "5h"}`;
    windows.set(id, {
      id,
      kind: weekly ? "weekly" : "session",
      label: `${group.label} · ${weekly ? "Weekly" : "5-hour"}`,
      usedPercent: 100 - left,
      windowDurationMins: weekly ? 7 * 24 * 60 : 5 * 60,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  return [...windows.values()];
}

export function readAntigravityQuotaTerminal(process: PtyProcess, now: () => number) {
  return Effect.callback<ServerProviderUsageWindow[] | null>((resume) => {
    let output = EMPTY_TERMINAL_OUTPUT;
    let requested = false;
    let removeExit = () => {};
    const complete = (windows: ServerProviderUsageWindow[] | null) => {
      removeData();
      removeExit();
      resume(Effect.succeed(windows));
    };
    const removeData = process.onData((chunk) => {
      output = appendTerminalOutput(output, chunk, 16 * 1024);
      const screen = NodeUtil.stripVTControlCharacters(output.text);
      if (AUTH_REQUIRED.test(screen)) {
        complete(null);
      } else if (!requested && /^\? for shortcuts\b/m.test(screen)) {
        requested = true;
        try {
          process.write("/usage\r");
        } catch {
          complete([]);
        }
      } else if (requested && /\besc Close\b/i.test(screen)) {
        // AGY renders the close hint while the quota request is still loading.
        const windows = parseAntigravityCliQuota(screen, now());
        if (windows.length > 0) complete(windows);
      }
    });
    removeExit = process.onExit(() => complete([]));
    return Effect.sync(() => {
      removeData();
      removeExit();
    });
  });
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
  readonly workspace: string;
  readonly loginPath: string;
  readonly loginTarget: string;
  readonly executable: string;
}): { readonly command: string; readonly args: ReadonlyArray<string> } {
  if (input.platform === "darwin") {
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-D", `HOME_DIR=${input.home}`, "-p", MACOS_QUOTA_SANDBOX_PROFILE, input.executable],
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
      input.workspace,
      "--",
      input.executable,
    ],
  };
}

export const probeAntigravityCliQuota = Effect.fn("probeAntigravityCliQuota")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly executable: Effect.Effect<string, AntigravityInstallationError, Scope.Scope>;
  readonly environment: NodeJS.ProcessEnv;
  readonly pty: PtyAdapter["Service"] | undefined;
}) {
  const started = yield* DateTime.now;
  const checkedAt = DateTime.formatIso(started);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  const platform = yield* HostProcess.Platform;
  if (input.authMethod !== "oauth-personal" || !isQuotaSandboxPlatform(platform) || !input.pty) {
    return unsupported;
  }
  const pty = input.pty;
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
    const workspace = path.join(home, "workspace");
    const cliCache = path.join(cliDirectory, "cache");
    yield* fs.makeDirectory(workspace);
    yield* fs.makeDirectory(cliCache, { recursive: true });
    if (platform === "darwin") {
      yield* fs.symlink(yield* fs.realPath(loginPath), loginTarget);
    } else {
      yield* fs.writeFileString(loginTarget, "", { mode: 0o600 });
    }
    yield* fs.writeFileString(
      path.join(cliDirectory, "settings.json"),
      yield* encodeQuotaSettings({
        auth: { type: "oauth-personal" },
        trustedWorkspaces: [workspace],
      }),
    );
    // ACP already owns sign-in. Prime only the disposable CLI's local wizard state so
    // the quota subprocess does not show onboarding or submit data-use preferences.
    yield* fs.writeFileString(
      path.join(cliCache, "onboarding.json"),
      '{"onboardingComplete":true,"consumerOnboardingComplete":true,"enterpriseOnboardingComplete":true}',
    );
    const env = Object.fromEntries(
      Object.entries(input.environment).filter(([key]) => NETWORK_ENV.test(key)),
    );

    // The standalone CLI has its own home layout. Give it only this instance's
    // login and an isolated writable home, leaving the active ACP state untouched.
    const sandbox = antigravityQuotaSandboxCommand({
      platform,
      home,
      workspace,
      loginPath,
      loginTarget,
      executable,
    });
    let exited = false;
    const process = yield* Effect.acquireRelease(
      pty.spawn({
        shell: sandbox.command,
        args: [...sandbox.args],
        cwd: workspace,
        cols: 148,
        rows: 42,
        env: {
          ...env,
          HOME: home,
          TMPDIR: home,
          TERM: "xterm-256color",
          // agy keeps Google sign-ins in the OS keyring unless forced onto profile files:
          // 1.5.12–1.5.15 check SSH_CONNECTION; 1.5.16+ checks AGY_CLI_FORCE_FILE_TOKEN_STORAGE.
          SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
          AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
          AGY_CLI_DISABLE_AUTO_UPDATE: "true",
          BROWSER: "/bin/false",
        },
      }),
      (process) =>
        Effect.sync(() => {
          if (!exited) process.kill("SIGKILL");
        }).pipe(Effect.ignoreCause),
    );
    const removeExit = process.onExit(() => {
      exited = true;
    });
    yield* Effect.addFinalizer(() => Effect.sync(removeExit));
    const windows = yield* readAntigravityQuotaTerminal(process, Date.now);
    if (windows === null) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in to Antigravity again to read account quota.",
      });
    }
    return windows.length > 0
      ? makeUsageLimits({ checkedAt, windows })
      : makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Antigravity CLI terminal could not read account quota.",
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
