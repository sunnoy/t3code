import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { stageBundledNodeCli } from "./bundled-node-cli.ts";

const runLauncher = (executable: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(executable, args, {
        cwd,
        env: { PATH: "", HOME: cwd },
        extendEnv: false,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(child.stdout)),
        Stream.mkString(Stream.decodeText(child.stderr)),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  });

it.layer(NodeServices.layer)("bundled-node-cli", (it) => {
  it.effect(
    "stages runtime/node, .mjs chunks, and a PATH-free launcher that resolves symlinks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bundled-node-" });
        const serverDistDir = path.join(root, "dist");
        const contentDir = path.join(root, "archive");
        yield* fs.makeDirectory(serverDistDir);
        yield* fs.makeDirectory(contentDir);

        yield* fs.writeFileString(
          path.join(serverDistDir, "helper.mjs"),
          "export const greeting = 'ok';\n",
        );
        yield* fs.writeFileString(
          path.join(serverDistDir, "bin.mjs"),
          [
            "import { greeting } from './helper.mjs';",
            "console.log(JSON.stringify({ greeting, args: process.argv.slice(2), dir: import.meta.dirname }));",
          ].join("\n"),
        );
        yield* fs.writeFileString(path.join(serverDistDir, "bin.mjs.map"), "{}");

        const staged = yield* stageBundledNodeCli({
          serverDistDir,
          contentDir,
          nodeExecutablePath: process.execPath,
          expectedNodeVersion: process.versions.node,
          actualNodeVersion: process.versions.node,
        });

        assert.equal(staged.launcherPath, path.join(contentDir, "t3"));
        assert.equal(staged.signedExecutablePath, path.join(contentDir, "runtime/node"));
        assert.isFalse(yield* fs.exists(path.join(contentDir, "bin.mjs.map")));

        const direct = yield* runLauncher(staged.launcherPath, ["--version", "1"], root);
        assert.equal(direct.exitCode, 0, direct.stderr);
        const parsedDirect = JSON.parse(direct.stdout);
        assert.equal(parsedDirect.greeting, "ok");
        assert.deepEqual(parsedDirect.args, ["--version", "1"]);
        assert.equal(parsedDirect.dir, yield* fs.realPath(contentDir));

        const linkPath = path.join(root, "t3-link");
        yield* fs.symlink(staged.launcherPath, linkPath);
        const viaLink = yield* runLauncher(linkPath, ["serve"], root);
        assert.equal(viaLink.exitCode, 0, viaLink.stderr);
        const parsedLink = JSON.parse(viaLink.stdout);
        assert.deepEqual(parsedLink.args, ["serve"]);
        assert.equal(parsedLink.dir, yield* fs.realPath(contentDir));
      }),
  );

  it.effect("rejects mismatched Node versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bundled-node-mismatch-" });
      const error = yield* Effect.flip(
        stageBundledNodeCli({
          serverDistDir: path.join(root, "dist"),
          contentDir: path.join(root, "archive"),
          nodeExecutablePath: process.execPath,
          expectedNodeVersion: "99.0.0",
          actualNodeVersion: process.versions.node,
        }),
      );
      assert.include(error.message, "99.0.0");
    }),
  );
});
