import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { defaultVaultConfigText } from "../src/vaults.ts";

describe("default vault config", () => {
  it("stays byte-equal to the Python default config", async () => {
    const pythonDefault = await readFile(
      new URL("../../../src/great_minds/core/default_config.yaml", import.meta.url),
      "utf8",
    );

    expect(defaultVaultConfigText).toBe(pythonDefault);
  });
});
