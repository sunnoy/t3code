import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { NativeTelemetryClient, NativeTelemetryUnavailable } from "./NativeTelemetryClient.ts";

const unavailable = Effect.fail(
  new NativeTelemetryUnavailable({ reason: "disabled in this build" }),
);
const health = {
  status: "unavailable",
  hello: Option.none(),
  lastSampleAt: Option.none(),
  lastError: Option.some("Resource telemetry is disabled in this build."),
  restartCount: 0,
  sampleIntervalMs: 0,
} as const;

export const layer = Layer.succeed(NativeTelemetryClient, {
  capabilities: unavailable,
  snapshots: Stream.empty,
  readHistory: Effect.fn("NativeTelemetryClient.readHistory")(() => Effect.succeed([])),
  setExternalProcesses: Effect.fn("NativeTelemetryClient.setExternalProcesses")(() => Effect.void),
  setHostPowerState: Effect.fn("NativeTelemetryClient.setHostPowerState")(() => Effect.void),
  sampleNow: unavailable,
  processTable: Effect.succeed([]),
  retry: Effect.succeed(false),
  health: Effect.succeed(health),
  subscribeHealth: Effect.succeed({ latest: health, changes: Stream.empty }),
});
