import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { ConfigProvider, Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { AppConfig, AppConfigLive } from "../src/config.ts";
import {
  draftHintSystem,
  retrievalCore,
  webFactExtractionPrompt,
  webSearchGuidance,
} from "../src/query.ts";
import { defaultVaultConfigText } from "../src/vaults.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const loadConfig = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* AppConfig;
    }).pipe(
      Effect.provide(AppConfigLive),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              DATABASE_URL: "postgresql://great-minds.test/great_minds",
              JWT_SECRET: "default-config-test-secret",
              ...env,
            },
          }),
        ),
      ),
    ),
  );

describe("server config defaults", () => {
  it("uses a 60-day refresh window and local WebAuthn defaults", async () => {
    const config = await loadConfig({});

    expect(config.jwtRefreshExpiryDays).toBe(60);
    expect(config.webauthnRpId).toBe("localhost");
    expect(config.webauthnOrigins).toEqual(["http://localhost:5173"]);
    expect(config.webauthnRpName).toBe("Great Minds");
  });

  it("sends compile temperatures only to stages whose default models accept them", async () => {
    const defaults = await loadConfig({});
    expect(defaults.extractTemperature).toEqual(Option.some(0.2));
    expect(defaults.renderTemperature).toEqual(Option.some(0.3));

    const overridden = await loadConfig({ EXTRACT_TEMPERATURE: "none", RENDER_TEMPERATURE: "0.4" });
    expect(overridden.extractTemperature).toEqual(Option.none());
    expect(overridden.renderTemperature).toEqual(Option.some(0.4));
  });

  it("embeds one search batch at a time unless configured otherwise", async () => {
    expect((await loadConfig({})).compileEmbedConcurrency).toBe(1);
    expect((await loadConfig({ COMPILE_EMBED_CONCURRENCY: "2" })).compileEmbedConcurrency).toBe(2);
  });

  it("sends no reasoning effort unless a role sets one", async () => {
    const defaults = await loadConfig({});
    expect([
      defaults.queryReasoningEffort,
      defaults.extractReasoningEffort,
      defaults.mapReasoningEffort,
      defaults.reduceReasoningEffort,
    ]).toEqual([Option.none(), Option.none(), Option.none(), Option.none()]);
    const set = await loadConfig({ QUERY_REASONING_EFFORT: "low", MAP_REASONING_EFFORT: "high" });
    expect([set.queryReasoningEffort, set.mapReasoningEffort]).toEqual([
      Option.some("low"),
      Option.some("high"),
    ]);
  });

  it("gives every model role a temperature that can be turned off", async () => {
    const defaults = await loadConfig({});
    expect([
      defaults.queryTemperature,
      defaults.extractTemperature,
      defaults.mapTemperature,
      defaults.reduceTemperature,
      defaults.renderTemperature,
    ]).toEqual([
      Option.some(0.3),
      Option.some(0.2),
      Option.some(0),
      Option.none(),
      Option.some(0.3),
    ]);
    const off = await loadConfig({
      QUERY_TEMPERATURE: "none",
      EXTRACT_TEMPERATURE: "none",
      MAP_TEMPERATURE: "none",
      RENDER_TEMPERATURE: "none",
    });
    expect([
      off.queryTemperature,
      off.extractTemperature,
      off.mapTemperature,
      off.renderTemperature,
    ]).toEqual([Option.none(), Option.none(), Option.none(), Option.none()]);
  });

  it("refuses a model whose provider is not listed or whose price is missing", async () => {
    const moonshot = {
      PROVIDERS: "moonshot",
      PROVIDER_MOONSHOT_URL: "https://api.moonshot.test/v1",
      RENDER_MODEL: "moonshot:kimi-k3",
    };
    await expect(loadConfig({ RENDER_MODEL: "moonshot:kimi-k3" })).rejects.toThrow(
      "which PROVIDERS does not list",
    );
    await expect(loadConfig(moonshot)).rejects.toThrow("MODEL_PRICES needs an entry");
    const config = await loadConfig({ ...moonshot, MODEL_PRICES: "moonshot:kimi-k3=0.6/2.5" });
    expect(config.providers.get("moonshot")).toMatchObject({ kind: "openai" });
    expect(config.modelPrices.get("moonshot:kimi-k3")).toEqual({
      inputPerMillion: 0.6,
      outputPerMillion: 2.5,
    });
  });

  it("asks the writer for high reasoning effort unless configured otherwise", async () => {
    expect((await loadConfig({})).renderReasoningEffort).toEqual(Option.some("high"));
    expect((await loadConfig({ RENDER_REASONING_EFFORT: "none" })).renderReasoningEffort).toEqual(
      Option.some("none"),
    );
    expect((await loadConfig({ RENDER_REASONING_EFFORT: "low" })).renderReasoningEffort).toEqual(
      Option.some("low"),
    );
  });
});

describe("default vault config", () => {
  it("stays byte-exact", () => {
    expect(sha256(defaultVaultConfigText)).toBe(
      "08ca735e39ad08aa743e09ecef13e4e0b48ea1c56ef04fe8ae53e8f16d36fbe5",
    );
  });
});

describe("hardcoded query prompts", () => {
  it("stay byte-exact", () => {
    expect(sha256(retrievalCore)).toBe(
      "85ed51c9129912390fcb093fa3bfa3d44252b8b9f80f9a9f4277f7b500d44d76",
    );
    expect(sha256(webSearchGuidance)).toBe(
      "bf27e028c94049d58ec0add50236bb09db24d52114001156eb07c2295885d0a9",
    );
    expect(sha256(webFactExtractionPrompt)).toBe(
      "7a4a78454df8c1ceafa937c3a5e3976b4683dae3ba66727e2128efdc01e4f9e9",
    );
    expect(sha256(draftHintSystem)).toBe(
      "d849c1c4ec5eff3b7e7fe42539effc3e6e104232c80bc3e4a52ee775cc3b15d4",
    );
  });
});

describe("default prompts", () => {
  it("keeps every prompt byte-exact", async () => {
    const directory = new URL("../src/default_prompts/", import.meta.url);
    const expected = {
      "check_link.md": "8e082d78c0b3651e83a2fb62ad0a4b9835c05c51566962f3579f7180b1f5b801",
      "extract.md": "0d589c31e7c6413e4aaaea6f70b36d9c36a8a81aa2bfc024477779e4f3c62dda",
      "find_mentions.md": "4da0570d7ca379f3917bbdff2f5c600d5e159bc8f8355ae49b4a4381eb470b07",
      "judge_same_entry.md": "dae66ffc8fecb4e71f3eeed42ad8a3bf4ba1028f7b5c51425bb6bbe72f00ee3e",
      "judge_same_topic.md": "7549d1683b3d55d02778bc391231cb1dd75f0f677ab753a30ccf84e0cc0ed4a4",
      "pick_link_target.md": "58ac245e4a62e13cc46db5ba7a8bdf1c437c4759f721afa3e8d96472bdd3b679",
      "place_in_article.md": "c7467eb781f0e545298ca85da6cfc8cd33fdea301d8597b79e342efa064d67fc",
      "propose_topics.md": "d906ea9a0c763f7747f56fc9dcb2e8524e85780e9279e4a5669344881d6c1e49",
      "query.md": "d02c29eb9d1367ef61e230741aee22feb3a2dea6564956ff2a433a34c876afee",
      "query_btw.md": "1415f3050b8c6b36867f2f0390281c775a3103991a6ad5a3e296fd7d42cdc138",
      "write_article.md": "35ee32e8fcddf52457c77e542975f83ca429184318d2ba3000ddd9ce26540324",
    } as const;
    const names = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
    expect(names).toEqual(Object.keys(expected));
    for (const name of names) {
      const prompt = await readFile(new URL(name, directory), "utf8");
      expect(sha256(prompt), name).toBe(expected[name as keyof typeof expected]);
    }
  });
});
