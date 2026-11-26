import type { SDKModel, SDKUser } from "@cursor/sdk";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as CursorSdk from "./CursorSdk.ts";
import { isCursorSdkError } from "./sdk.ts";

export interface CursorSdkCatalogSnapshot {
  readonly user: SDKUser | undefined;
  readonly models: ReadonlyArray<SDKModel>;
}

export class CursorSdkCatalogError extends Schema.TaggedError<CursorSdkCatalogError>()(
  "CursorSdkCatalogError",
  {
    authenticationFailure: Schema.Boolean,
    status: Schema.optionalKey(Schema.Number),
    code: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.authenticationFailure
      ? "Cursor SDK authentication failed."
      : "Cursor SDK catalog request failed.";
  }

  get planRequired(): boolean {
    return this.code === "plan_required";
  }

  get accountBlocked(): boolean {
    return this.status === 403 && !this.planRequired;
  }
}

export class CursorSdkCatalog extends Context.Service<
  CursorSdkCatalog,
  {
    readonly read: (
      apiKey: string,
    ) => Effect.Effect<CursorSdkCatalogSnapshot, CursorSdkCatalogError>;
  }
>()("@t3tools/provider-cursor/server/CursorSdkCatalog") {}

export interface CursorSdkCatalogProbes {
  readonly readUser: (apiKey: string) => Effect.Effect<SDKUser, CursorSdkCatalogError>;
  readonly readModels: (
    apiKey: string,
  ) => Effect.Effect<ReadonlyArray<SDKModel>, CursorSdkCatalogError>;
}

const makeLiveProbes = Effect.gen(function* () {
  const sdkService = yield* CursorSdk.CursorSdk;
  const request = <A>(run: (cursor: ReturnType<typeof sdkService.load>["Cursor"]) => Promise<A>) =>
    Effect.tryPromise({
      try: () => run(sdkService.load().Cursor),
      catch: (cause) => {
        const error = isCursorSdkError(cause, "CursorSdkError") ? cause : undefined;
        const status = error?.status;
        const code = error?.code;
        return new CursorSdkCatalogError({
          authenticationFailure: isCursorSdkError(cause, "AuthenticationError") || status === 401,
          ...(status === undefined ? {} : { status }),
          ...(code === undefined ? {} : { code }),
          cause,
        });
      },
    });
  return {
    readUser: (apiKey) => request((cursor) => cursor.me({ apiKey })),
    readModels: (apiKey) => request((cursor) => cursor.models.list({ apiKey })),
  } satisfies CursorSdkCatalogProbes;
});

export const makeCursorSdkCatalog = Effect.fn("CursorSdkCatalog.make")(function* (
  probes: CursorSdkCatalogProbes,
) {
  const modelCache = yield* Cache.makeWith(probes.readModels, {
    capacity: 32,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value.length > 0 ? Duration.minutes(30) : Duration.zero,
  });
  return CursorSdkCatalog.of({
    read: Effect.fn("CursorSdkCatalog.read")(function (apiKey) {
      return Effect.all(
        {
          // Enterprise teams can block account labels while model discovery still works.
          user: Effect.catchIf(
            probes.readUser(apiKey),
            (error: CursorSdkCatalogError): boolean => error.accountBlocked,
            () => Effect.undefined,
            (error: CursorSdkCatalogError) => Effect.fail(error),
          ),
          models: Cache.get(modelCache, apiKey),
        },
        { concurrency: "unbounded" },
      );
    }),
  });
});

export const layer = Layer.effect(
  CursorSdkCatalog,
  Effect.flatMap(makeLiveProbes, makeCursorSdkCatalog),
);

export function layerTest(
  read: CursorSdkCatalog["Service"]["read"],
): Layer.Layer<CursorSdkCatalog> {
  return Layer.succeed(CursorSdkCatalog, CursorSdkCatalog.of({ read }));
}
