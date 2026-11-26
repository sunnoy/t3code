// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("omits Connect inputs while retaining the normal build environment precedence", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "FORK_CONFIG=root\nT3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "FORK_CONFIG=local\nEXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_local\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot })).toEqual({ FORK_CONFIG: "local" });
    expect(
      loadRepoEnv({
        baseEnv: {
          FORK_CONFIG: "ci",
          VITE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          VITE_T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toEqual({ FORK_CONFIG: "ci" });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
