import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { TelemetryLive } from "alchemy/Telemetry/Layer";
import { buildEventTelemetry, configuredDestinations } from "alchemy/TelemetryRuntime";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

it.effect("keeps Alchemy CLI and Worker exporters off with telemetry configuration", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const profile = yield* fs.makeTempDirectoryScoped({ prefix: "t3-alchemy-telemetry-" });
    vi.stubEnv("ALCHEMY_HOME", profile);
    vi.stubEnv("ALCHEMY_TELEMETRY_DISABLED", "");
    vi.stubEnv("DO_NOT_TRACK", "");
    vi.stubEnv("NO_TRACK", "");
    const fetchFn = vi.fn<typeof fetch>();
    try {
      yield* Effect.gen(function* () {
        expect(yield* configuredDestinations).toEqual([]);
        const probe = Effect.void.pipe(Effect.withSpan("fixture"));
        const event = yield* buildEventTelemetry(yield* Effect.context(), yield* Effect.scope);
        yield* probe.pipe(Effect.provideContext(event));
        const cli = yield* Layer.build(TelemetryLive);
        yield* probe.pipe(Effect.provideContext(cli));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
              ALCHEMY_OTEL_EXPORTERS: '[{"traces":{"url":"https://binding.example.test"}}]',
            }),
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetchFn),
      );
      expect(yield* fs.exists(path.join(profile, "id"))).toBe(false);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
