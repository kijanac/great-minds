import * as Comlink from "comlink";
import { createLocalContext } from "../db/client";
import { ensureWorkspace } from "../services/bootstrap";
import { deleteSource, listSources } from "../services/sources";
import {
  createVault,
  getVaultSettings,
  listVaults,
  switchVault,
  updateVault,
} from "../services/vaults";
import { DeleteSourceCommandSchema, ListSourcesQuerySchema } from "../schema/source";
import { CreateVaultCommandSchema, UpdateVaultCommandSchema } from "../schema/vault";
import type { LocalApi } from "./api";

const LOCAL_DATA_DIR = "idb://great-minds-local-v1";

const ctxPromise = createLocalContext({
  dataDir: LOCAL_DATA_DIR,
});

const localApi = {
  async ensureWorkspace() {
    const ctx = await ctxPromise;
    return ensureWorkspace(ctx);
  },
  async listVaults() {
    const ctx = await ctxPromise;
    return listVaults(ctx);
  },
  async getVaultSettings(vaultId: string) {
    const ctx = await ctxPromise;
    return getVaultSettings(ctx, vaultId);
  },
  async listSources(query) {
    const parsed = ListSourcesQuerySchema.parse(query);
    const ctx = await ctxPromise;
    return listSources(ctx, parsed);
  },
  async deleteSource(command) {
    const parsed = DeleteSourceCommandSchema.parse(command);
    const ctx = await ctxPromise;
    return deleteSource(ctx, parsed);
  },
  async createVault(command) {
    const parsed = CreateVaultCommandSchema.parse(command);
    const ctx = await ctxPromise;
    return createVault(ctx, parsed);
  },
  async updateVault(command) {
    const parsed = UpdateVaultCommandSchema.parse(command);
    const ctx = await ctxPromise;
    return updateVault(ctx, parsed);
  },
  async switchVault(vaultId: string) {
    const ctx = await ctxPromise;
    return switchVault(ctx, vaultId);
  },
} satisfies LocalApi;

Comlink.expose(localApi);
