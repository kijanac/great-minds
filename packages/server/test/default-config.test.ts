import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  draftHintSystem,
  retrievalCore,
  webFactExtractionPrompt,
  webSearchGuidance,
} from "../src/query.ts";
import { defaultVaultConfigText } from "../src/vaults.ts";

const execFileAsync = promisify(execFile);

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
    const vaultConfig = new URL(
      "../../../src/great_minds/core/vaults/config.py",
      import.meta.url,
    );

    await expect(pythonConstant(querier, "_RETRIEVAL_CORE")).resolves.toBe(retrievalCore);
    await expect(pythonConstant(querier, "_WEB_SEARCH_GUIDANCE")).resolves.toBe(
      webSearchGuidance,
    );
    await expect(pythonConstant(querier, "_WEB_FACT_EXTRACTION_PROMPT")).resolves.toBe(
      webFactExtractionPrompt,
    );
    await expect(pythonConstant(vaultConfig, "_DRAFT_HINT_SYSTEM")).resolves.toBe(
      draftHintSystem,
    );
  });
});

describe("default prompts", () => {
  const names = [
    "canonicalize_assign.md",
    "canonicalize_registry.md",
    "cleanup.md",
    "extract.md",
    "query.md",
    "query_btw.md",
    "render.md",
    "synthesize.md",
  ] as const;

  it.each(names)("%s stays byte-equal to the Python default prompt", async (name) => {
    const pythonDir = new URL("../../../src/great_minds/core/default_prompts/", import.meta.url);
    const tsDir = new URL("../src/default_prompts/", import.meta.url);
    const [pythonPrompt, tsPrompt] = await Promise.all([
      readFile(new URL(name, pythonDir), "utf8"),
      readFile(new URL(name, tsDir), "utf8"),
    ]);
    expect(tsPrompt).toBe(pythonPrompt);
  });
});
