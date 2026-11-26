import type { SDKModel, SDKUser } from "@cursor/sdk";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";
import * as CursorSdk from "./CursorSdk.ts";
import { loadCursorSdk, loadCursorSqlite } from "./sdk.ts";

const user = {
  apiKeyName: "test-key",
  userEmail: "cursor@example.com",
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies SDKUser;

const model = {
  id: "claude-opus-4-8",
  displayName: "Opus 4.8",
  parameters: [],
} satisfies SDKModel;

const catalogError = () =>
  new CursorSdkCatalog.CursorSdkCatalogError({
    authenticationFailure: false,
    cause: new Error("catalog unavailable"),
  });

describe("CursorSdkCatalog", () => {
  it.effect("gets the user and models through the Cursor SDK", () =>
    Effect.gen(function* () {
      const keys: Array<string | undefined> = [];
      const { Cursor } = loadCursorSdk();
      const me = vi.spyOn(Cursor, "me").mockImplementation(async (options) => {
        keys.push(options?.apiKey);
        return user;
      });
      const models = vi.spyOn(Cursor.models, "list").mockImplementation(async (options) => {
        keys.push(options?.apiKey);
        return [model];
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          me.mockRestore();
          models.mockRestore();
        }),
      );
      const catalog = yield* CursorSdkCatalog.CursorSdkCatalog.pipe(
        Effect.provide(
          CursorSdkCatalog.layer.pipe(
            Layer.provide(
              Layer.succeed(CursorSdk.CursorSdk, {
                load: loadCursorSdk,
                loadSqlite: loadCursorSqlite,
              }),
            ),
          ),
        ),
      );
      expect(yield* catalog.read("instance-key")).toEqual({ user, models: [model] });
      expect(keys).toEqual(["instance-key", "instance-key"]);
    }),
  );

  it.effect("shares concurrent first model discovery until the response arrives", () =>
    Effect.gen(function* () {
      const modelsEntered = yield* Deferred.make<void>();
      const secondUserEntered = yield* Deferred.make<void>();
      const response = yield* Deferred.make<ReadonlyArray<SDKModel>>();
      let userCalls = 0;
      let modelCalls = 0;
      const catalog = yield* CursorSdkCatalog.makeCursorSdkCatalog({
        readUser: () =>
          Effect.gen(function* () {
            userCalls += 1;
            if (userCalls === 2) yield* Deferred.succeed(secondUserEntered, undefined);
            return user;
          }),
        readModels: () =>
          Effect.gen(function* () {
            modelCalls += 1;
            yield* Deferred.succeed(modelsEntered, undefined);
            return yield* Deferred.await(response);
          }),
      });
      expect(modelCalls).toBe(0);
      const first = yield* catalog.read("test-key").pipe(Effect.forkChild);
      yield* Deferred.await(modelsEntered);
      const second = yield* catalog.read("test-key").pipe(Effect.forkChild);
      yield* Deferred.await(secondUserEntered);
      expect(modelCalls).toBe(1);
      yield* Deferred.succeed(response, [model]);
      expect((yield* Fiber.join(first)).models).toEqual([model]);
      expect((yield* Fiber.join(second)).models).toEqual([model]);
    }),
  );

  it.effect("does not cache failed or empty model discovery", () =>
    Effect.gen(function* () {
      let modelCalls = 0;
      const catalog = yield* CursorSdkCatalog.makeCursorSdkCatalog({
        readUser: () => Effect.succeed(user),
        readModels: () =>
          Effect.suspend(() => {
            modelCalls += 1;
            if (modelCalls === 1) return Effect.fail(catalogError());
            if (modelCalls === 2) return Effect.succeed([]);
            return Effect.succeed([model]);
          }),
      });

      expect(Exit.isFailure(yield* Effect.exit(catalog.read("test-key")))).toBe(true);
      expect((yield* catalog.read("test-key")).models).toEqual([]);
      expect((yield* catalog.read("test-key")).models).toEqual([model]);
      expect((yield* catalog.read("test-key")).models).toEqual([model]);
      expect(modelCalls).toBe(3);
    }),
  );
});
