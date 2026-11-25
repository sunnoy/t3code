import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import { OtlpEndpointCheck, layer } from "./OtlpEndpointCheck.ts";

it.effect("declines to send a telemetry endpoint check", () =>
  Effect.gen(function* () {
    const fetchFn = vi.fn<typeof fetch>();
    const check = yield* OtlpEndpointCheck.pipe(
      Effect.flatMap((service) =>
        service.check({ signal: "traces", url: "https://collector.example.test/v1/traces" }),
      ),
      Effect.provide(Layer.merge(layer, FetchHttpClient.layer)),
      Effect.provideService(FetchHttpClient.Fetch, fetchFn),
    );
    expect(check).toEqual({ _tag: "Unreachable", timedOut: false });
    expect(fetchFn).not.toHaveBeenCalled();
  }),
);
