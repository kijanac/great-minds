import { Effect, Layer, Option } from "effect";

import { makeAppLayers } from "./app-layer.ts";
import { makeTestClock } from "./clock.ts";
import { AppConfig, AppConfigLive } from "./config.ts";
import { makeTestRandomBytes } from "./random.ts";
import { startServer } from "./server.ts";

const MainLive = Layer.unwrap(
  Effect.map(AppConfig, (config) => {
    if (Option.isSome(config.goldensClock) || Option.isSome(config.goldensRandomSeed)) {
      console.error(
        JSON.stringify({
          event: "determinism_pins_active",
          level: "warn",
          detail:
            "GOLDENS_CLOCK/GOLDENS_RANDOM_SEED pin the clock and identity stream; never set these in production",
        }),
      );
    }
    const layers = makeAppLayers({
      config: Layer.succeed(AppConfig, config),
      ...(Option.isSome(config.goldensClock)
        ? { clock: makeTestClock(config.goldensClock.value).layer }
        : {}),
      ...(Option.isSome(config.goldensRandomSeed)
        ? { randomBytes: makeTestRandomBytes(config.goldensRandomSeed.value).layer }
        : {}),
    });
    return Layer.mergeAll(layers.app, layers.reconcilerLoop);
  }),
).pipe(Layer.provide(AppConfigLive));

const started = await startServer({
  layer: MainLive,
});
console.log(JSON.stringify({ event: "server_listening", url: started.url }));
