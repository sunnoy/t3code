import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import { AnalyticsService, layer } from "./AnalyticsService.ts";

it.effect("does not enable product analytics from the environment", () =>
  Effect.gen(function* () {
    const fetchFn = vi.fn<typeof fetch>();
    yield* Effect.gen(function* () {
      const analytics = yield* AnalyticsService;
      expect(yield* analytics.record("server.boot.heartbeat")).toBe(false);
      yield* analytics.recordOwners([{ source: "connect", ownerId: "test" }], "server");
      yield* analytics.flush;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          FetchHttpClient.layer,
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              T3CODE_TELEMETRY_ENABLED: "true",
              T3CODE_POSTHOG_HOST: "https://collector.example.test",
            }),
          ),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetchFn),
    );
    expect(fetchFn).not.toHaveBeenCalled();
  }),
);
