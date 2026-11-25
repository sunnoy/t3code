import * as Layer from "effect/Layer";
import * as References from "effect/References";
import { HttpClient } from "effect/http";

import * as ServerLogger from "../serverLogger.ts";

export const layer = Layer.mergeAll(
  ServerLogger.layer,
  Layer.succeed(References.TracerEnabled, false),
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
);
