import { Layer } from "effect";

import { makeAppLayers } from "./app-layer.ts";
import { startServer } from "./server.ts";

const layers = makeAppLayers();
const started = await startServer({
  layer: Layer.mergeAll(layers.app, layers.reconcilerLoop),
});
console.log(JSON.stringify({ event: "server_listening", url: started.url }));
