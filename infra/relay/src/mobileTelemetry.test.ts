import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { RelayApi } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { vi } from "vite-plus/test";

import { RELAY_HTTP_ROUTER_CONFIG } from "./http/Api.ts";
import * as MobileTelemetry from "./mobileTelemetry.ts";

it.effect.each(["logs", "metrics", "traces"])(
  "acknowledges legacy %s without reading or forwarding the body",
  (signal) =>
    Effect.gen(function* () {
      const execute = vi.fn(() => Effect.die("unexpected telemetry request"));
      const body = vi.fn(() => {
        throw new Error("unexpected telemetry body read");
      });
      const request = new Request(
        `https://relay.test/v1/mobile/observe/d763fcb8-d37c-41ea-a773-b54a0ab4a454/v1/${signal}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "payload" },
      );
      vi.spyOn(request, "text").mockImplementation(body);
      vi.spyOn(request, "arrayBuffer").mockImplementation(body);
      const handler = yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.mobileTelemetry)).pipe(
          Layer.provide(MobileTelemetry.layer),
          Layer.provide([NodeServices.layer, NodeHttpPlatform.layer, Etag.layerWeak]),
        ),
      ).pipe(Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG));
      const respond = vi.fn(() => Effect.void);
      yield* HttpEffect.toHandled(handler, respond).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
        Effect.provideService(HttpClient.HttpClient, HttpClient.make(execute)),
      );
      expect(respond).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 204 }),
      );
      expect(body).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    }),
);
