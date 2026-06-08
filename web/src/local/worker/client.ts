import * as Comlink from "comlink";
import type { Workspace } from "../schema/workspace";
import type { LocalApi } from "./api";

type LocalApiClient = {
  worker: Worker;
  api: Comlink.Remote<LocalApi>;
};

function createLocalApiClient(): LocalApiClient {
  const worker = new Worker(new URL("./api.worker.ts", import.meta.url), {
    type: "module",
    name: "great-minds-local",
  });

  return {
    worker,
    api: Comlink.wrap<LocalApi>(worker),
  };
}

function disposeClient(client: LocalApiClient): void {
  client.api[Comlink.releaseProxy]();
  client.worker.terminate();
}

let client = createLocalApiClient();
let bootPromise: Promise<Workspace> | undefined;

export let localApi: Comlink.Remote<LocalApi> = client.api;

export function bootLocalApp(): Promise<Workspace> {
  bootPromise ??= localApi.ensureWorkspace();
  return bootPromise;
}

export function restartLocalApp(): Promise<Workspace> {
  disposeClient(client);
  client = createLocalApiClient();
  localApi = client.api;
  bootPromise = undefined;
  return bootLocalApp();
}

export function disposeLocalApi(): void {
  disposeClient(client);
  bootPromise = undefined;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeLocalApi();
  });
}
