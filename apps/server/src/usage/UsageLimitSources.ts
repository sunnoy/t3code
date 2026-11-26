import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  HttpQuotaResponse,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ProviderDriverKind,
  type ServerSettings,
  UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { hubRoutes } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClientError from "effect/http/HttpClientError";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as Settings from "../serverSettings.ts";
import { windowLimitsModel } from "../provider/claudeUsageLimits.ts";

const decodeHttpQuotaJson = Schema.decodeUnknownEffect(Schema.fromJsonString(HttpQuotaResponse));
const decodeHttpQuotaResponse = Effect.fn("UsageLimitSources.decodeHttpQuotaResponse")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  let bytes = 0;
  const text = yield* response.stream.pipe(
    Stream.mapEffect((chunk) => {
      bytes += chunk.byteLength;
      return bytes > 1024 * 1024
        ? Effect.fail(
            new HttpClientError.DecodeError({
              request: response.request,
              response,
              description: "HTTP quota response exceeds 1 MiB.",
            }),
          )
        : Effect.succeed(chunk);
    }),
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (text, chunk) => text + chunk,
    ),
  );
  return yield* decodeHttpQuotaJson(text);
});

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const settingsService = yield* Settings.ServerSettingsService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const url = URL.parse(config.url);
    const base = {
      id,
      kind: config.kind,
      label: sourceLabel(id, config),
      ...(config.kind === "cliproxy" && url && /^https?:$/.test(url.protocol)
        ? {
            origin: url.origin,
            endpoint: `${url.origin}${url.pathname.replace(/(\/management\.html)?\/*$/i, "")}`,
          }
        : {}),
      checkedAt,
    } as const;
    if (config.kind === "http") {
      if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password) {
        return { ...base, accounts: [], error: "Invalid HTTP quota source URL." };
      }
      if (config.managementKey !== "") {
        return {
          ...base,
          accounts: [],
          error: "Authenticated quota sources are disabled in this build.",
        };
      }
      const request = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader("Accept", "application/json"),
      );
      const result = yield* http
        .execute(request)
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(decodeHttpQuotaResponse),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.timeout("10 seconds"),
          Effect.result,
        );
      return result._tag === "Success"
        ? { ...base, accounts: [], quotaAccounts: result.success.accounts }
        : { ...base, accounts: [], error: "Could not read the HTTP quota source." };
    }
    return {
      ...base,
      accounts: [],
      error: "Authenticated quota sources are disabled in this build.",
    };
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    next: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(snapshots);
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  const consumeResetCredit = () =>
    Effect.fail(new UsageLimitSourceError({ detail: "Redeem credits through the provider." }));

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    refresh,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make);

/** A hub returns a usage limit only when every account it routes the model to is spent. */
export function hubPoolResetAt(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  driver: ProviderDriverKind,
  model: string | null,
  now: number,
): string | null {
  let earliest: number | null = null;
  const routes = hubRoutes(sources, driver, model);
  for (const account of sources.flatMap((source) => source.accounts).filter(routes)) {
    // An unread account may be the one still blocked, so its refill is unknown.
    if (account.usageLimits.unavailable) return null;
    const spent = account.usageLimits.windows.filter(
      (window) => window.usedPercent >= 100 && windowLimitsModel(window, model),
    );
    if (spent.length === 0) return null;
    const resets = spent.map((window) => Date.parse(window.resetsAt ?? ""));
    if (resets.some((reset) => !Number.isFinite(reset))) return null;
    const recoversAt = Math.max(...resets);
    if (recoversAt <= now) return null;
    earliest = earliest === null ? recoversAt : Math.min(earliest, recoversAt);
  }
  return earliest === null ? null : DateTime.formatIso(DateTime.makeUnsafe(earliest));
}

export class UsageLimitResetFallback extends Context.Reference<{
  readonly resetAt: (
    driver: ProviderDriverKind,
    endpoint: string,
    model: string | null,
  ) => Effect.Effect<string | null>;
}>("t3/usage/UsageLimitResetFallback", {
  defaultValue: () => ({ resetAt: () => Effect.succeed(null) }),
}) {}

export const layerResetFallback = Layer.effect(
  UsageLimitResetFallback,
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources;
    return {
      resetAt: Effect.fn("UsageLimitResetFallback.resetAt")(function* (driver, endpoint, model) {
        // Only the hub at the instance's endpoint serves its turns.
        const atEndpoint = Effect.map(sources.current, (current) =>
          current.filter((source) => source.origin === endpoint),
        );
        if ((yield* atEndpoint).length === 0) return null;
        // The pool usually ran out after the last poll, so the cached accounts still show room.
        yield* sources.refresh.pipe(Effect.timeout("5 seconds"), Effect.ignore);
        return hubPoolResetAt(
          yield* atEndpoint,
          driver,
          model,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
      }),
    };
  }),
);
