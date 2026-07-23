import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";

import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AppConfig, AppConfigLive } from "../src/config.ts";
import {
  draftHintSystem,
  retrievalCore,
  webFactExtractionPrompt,
  webSearchGuidance,
} from "../src/query.ts";
import { defaultVaultConfigText } from "../src/vaults.ts";

const execFileAsync = promisify(execFile);

describe("server config defaults", () => {
  it("uses a 60-day refresh window and local WebAuthn defaults", async () => {
    const provider = ConfigProvider.fromEnv({
      env: {
        DATABASE_URL: "postgresql://great-minds.test/great_minds",
        JWT_SECRET: "default-config-test-secret",
      },
    });
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* AppConfig;
      }).pipe(Effect.provide(AppConfigLive), Effect.provide(ConfigProvider.layer(provider))),
    );

    expect(config.jwtRefreshExpiryDays).toBe(60);
    expect(config.webauthnRpId).toBe("localhost");
    expect(config.webauthnOrigins).toEqual(["http://localhost:5173"]);
    expect(config.webauthnRpName).toBe("Great Minds");
  });
});

const pythonConstant = async (file: URL, constantName: string) => {
  const { stdout } = await execFileAsync("python3", [
    "-c",
    [
      "import ast, pathlib, sys",
      "path = pathlib.Path(sys.argv[1])",
      "name = sys.argv[2]",
      "module = ast.parse(path.read_text(encoding='utf-8'))",
      "for node in module.body:",
      "    if isinstance(node, ast.Assign):",
      "        if any(isinstance(t, ast.Name) and t.id == name for t in node.targets):",
      "            value = ast.literal_eval(node.value)",
      "            sys.stdout.write(value)",
      "            raise SystemExit(0)",
      "raise SystemExit(f'constant not found: {name}')",
    ].join("\n"),
    file.pathname,
    constantName,
  ]);
  return stdout;
};

describe("default vault config", () => {
  it("stays byte-equal to the Python default config", async () => {
    const pythonDefault = await readFile(
      new URL("../../../src/great_minds/core/default_config.yaml", import.meta.url),
      "utf8",
    );

    expect(defaultVaultConfigText).toBe(pythonDefault);
  });
});

describe("hardcoded query prompts", () => {
  it("stay byte-equal to Python source constants", async () => {
    const querier = new URL("../../../src/great_minds/core/querier.py", import.meta.url);
    const vaultConfig = new URL("../../../src/great_minds/core/vaults/config.py", import.meta.url);

    await expect(pythonConstant(querier, "_RETRIEVAL_CORE")).resolves.toBe(retrievalCore);
    await expect(pythonConstant(querier, "_WEB_SEARCH_GUIDANCE")).resolves.toBe(webSearchGuidance);
    await expect(pythonConstant(querier, "_WEB_FACT_EXTRACTION_PROMPT")).resolves.toBe(
      webFactExtractionPrompt,
    );
    await expect(pythonConstant(vaultConfig, "_DRAFT_HINT_SYSTEM")).resolves.toBe(draftHintSystem);
  });
});

describe("default prompts", () => {
  it("keeps every Python default prompt byte-equal in TypeScript", async () => {
    const pythonDir = new URL("../../../src/great_minds/core/default_prompts/", import.meta.url);
    const tsDir = new URL("../src/default_prompts/", import.meta.url);
    const names = (await readdir(pythonDir)).filter((name) => name.endsWith(".md")).sort();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const [pythonPrompt, tsPrompt] = await Promise.all([
        readFile(new URL(name, pythonDir), "utf8"),
        readFile(new URL(name, tsDir), "utf8"),
      ]);
      expect(tsPrompt, name).toBe(pythonPrompt);
    }
  });
});
