import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class BundledNodeCliError extends Schema.TaggedError<BundledNodeCliError>()(
  "BundledNodeCliError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * POSIX launcher for bundled-Node archives (used on darwin-x64 where Node SEA segfaults).
 * Uses only shell builtins plus macOS `/usr/bin/readlink` so it still runs when `PATH=""`
 * (as in `smoke-cli-archive.ts` and minimal launchd environments).
 */
export const BUNDLED_NODE_LAUNCHER_SCRIPT = `#!/bin/sh
set -eu
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  case "$SOURCE" in
    */*)
      PARENT="\${SOURCE%/*}"
      DIR="$(CDPATH= cd -P -- "\${PARENT:-/}" && pwd)"
      ;;
    *) DIR="$(pwd)" ;;
  esac
  READLINK=/usr/bin/readlink
  [ -x "$READLINK" ] || READLINK=/bin/readlink
  TARGET="$("$READLINK" "$SOURCE")"
  case "$TARGET" in
    /*) SOURCE="$TARGET" ;;
    *) SOURCE="$DIR/$TARGET" ;;
  esac
done
case "$SOURCE" in
  */*)
    PARENT="\${SOURCE%/*}"
    DIR="$(CDPATH= cd -P -- "\${PARENT:-/}" && pwd)"
    ;;
  *) DIR="$(pwd)" ;;
esac
exec "$DIR/runtime/node" "$DIR/bin.mjs" "$@"
`;

/**
 * Stages a self-contained Node runtime + compiled server JS bundle for targets where Node SEA
 * cannot run (darwin-x64). Keeping the `.mjs` files at the archive root preserves
 * `import.meta.dirname` parity with SEA binaries so `client/`, workers,
 * and `node_modules/` resolve identically.
 */
export const stageBundledNodeCli = Effect.fn("bundledNodeCli.stage")(function* (input: {
  readonly serverDistDir: string;
  readonly contentDir: string;
  readonly nodeExecutablePath: string;
  readonly expectedNodeVersion: string;
  readonly actualNodeVersion: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (input.actualNodeVersion !== input.expectedNodeVersion) {
    return yield* new BundledNodeCliError({
      detail: `Bundled Node CLI archives must be built with Node ${input.expectedNodeVersion}; running ${input.actualNodeVersion}.`,
    });
  }

  const distEntry = path.join(input.serverDistDir, "bin.mjs");
  if (!(yield* fs.exists(distEntry))) {
    return yield* new BundledNodeCliError({
      detail: `Missing ${distEntry}. Run \`vp run --filter t3 build\` first.`,
    });
  }

  const entries = yield* fs.readDirectory(input.serverDistDir);
  for (const entry of entries) {
    if (!entry.endsWith(".mjs")) continue;
    yield* fs.copyFile(path.join(input.serverDistDir, entry), path.join(input.contentDir, entry));
  }

  const runtimeDir = path.join(input.contentDir, "runtime");
  yield* fs.makeDirectory(runtimeDir, { recursive: true });
  const realNodePath = yield* fs
    .realPath(input.nodeExecutablePath)
    .pipe(Effect.orElseSucceed(() => input.nodeExecutablePath));
  const bundledNodePath = path.join(runtimeDir, "node");
  yield* fs.copyFile(realNodePath, bundledNodePath);
  yield* fs.chmod(bundledNodePath, 0o755);

  const launcherPath = path.join(input.contentDir, "t3");
  yield* fs.writeFileString(launcherPath, BUNDLED_NODE_LAUNCHER_SCRIPT);
  yield* fs.chmod(launcherPath, 0o755);

  return {
    launcherPath,
    signedExecutablePath: bundledNodePath,
  };
});
