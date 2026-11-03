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
    expect(defaults.mapTemperature).toEqual(Option.some(0.3));
    expect(defaults.reduceTemperature).toEqual(Option.none());
    expect(defaults.renderTemperature).toEqual(Option.some(0.3));

    const overridden = await loadConfig({ EXTRACT_TEMPERATURE: "none", RENDER_TEMPERATURE: "0.4" });
    expect(overridden.extractTemperature).toEqual(Option.none());
    expect(overridden.renderTemperature).toEqual(Option.some(0.4));
  });

  it("runs the themes Update pipeline unless the registry fallback is chosen", async () => {
    expect((await loadConfig({})).compilePipeline).toBe("themes");
    expect((await loadConfig({ COMPILE_PIPELINE: "registry" })).compilePipeline).toBe("registry");
  });

  it("asks the writer for high reasoning effort unless configured otherwise", async () => {
    expect((await loadConfig({})).renderReasoningEffort).toEqual(Option.some("high"));
    expect((await loadConfig({ RENDER_REASONING_EFFORT: "none" })).renderReasoningEffort).toEqual(
      Option.none(),
    );
    expect((await loadConfig({ RENDER_REASONING_EFFORT: "low" })).renderReasoningEffort).toEqual(
      Option.some("low"),
    );
  });
});

describe("default vault config", () => {
  it("stays byte-exact", () => {
    expect(sha256(defaultVaultConfigText)).toBe(
      "fffd8a7c1c946d201a756a99bcff12bf8a803c824c3c2937153a7cf1ba95f7e6",
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
      "canonicalize_assign.md": "49d8130d26be11d16b146fa7f1e193e6a220640da3a71b7654a23fc85bc09d6a",
      "canonicalize_registry.md":
        "12cf15426368b0ad68f5dbc2e6c1b01e22a4deb95831cc8a07d302968333aafc",
      "check_link.md": "8e082d78c0b3651e83a2fb62ad0a4b9835c05c51566962f3579f7180b1f5b801",
      "cleanup.md": "61d0b385327da35bf09858da3738afbaf65505d45a6cb10025a4891a98340195",
      "extract.md": "0d589c31e7c6413e4aaaea6f70b36d9c36a8a81aa2bfc024477779e4f3c62dda",
      "find_mentions.md": "4da0570d7ca379f3917bbdff2f5c600d5e159bc8f8355ae49b4a4381eb470b07",
      "judge_same_entry.md": "dae66ffc8fecb4e71f3eeed42ad8a3bf4ba1028f7b5c51425bb6bbe72f00ee3e",
      "judge_same_topic.md": "7549d1683b3d55d02778bc391231cb1dd75f0f677ab753a30ccf84e0cc0ed4a4",
      "pick_link_target.md": "58ac245e4a62e13cc46db5ba7a8bdf1c437c4759f721afa3e8d96472bdd3b679",
      "place_in_article.md": "c7467eb781f0e545298ca85da6cfc8cd33fdea301d8597b79e342efa064d67fc",
      "propose_topics.md": "d906ea9a0c763f7747f56fc9dcb2e8524e85780e9279e4a5669344881d6c1e49",
      "query.md": "d02c29eb9d1367ef61e230741aee22feb3a2dea6564956ff2a433a34c876afee",
      "query_btw.md": "1415f3050b8c6b36867f2f0390281c775a3103991a6ad5a3e296fd7d42cdc138",
      "render.md": "b5dea1a1d30f7b4574e8fbb80bc70ad839de6ccc455b31576b4a920a4a130ad7",
      "synthesize.md": "9b122a4e2f11e9fb83428c321cb2cc70315105ca2660e350babc573bc72370bf",
      "synthesize_decompose.md": "74301aece5c13aa01e94d14db1a24f66a2d6ff8458035c2e13e79e1f95195f3a",
      "synthesize_revise.md": "c058afbc1c98fedcba67b65aed1b5b8a32b1615c607eef079ebb5876663cebcf",
      "write_article.md": "191ee1805c4e052125a8fc511e0ddba9d9b2f467611245073a65c3b467313db8",
    } as const;
    const names = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
    expect(names).toEqual(Object.keys(expected));
    for (const name of names) {
      const prompt = await readFile(new URL(name, directory), "utf8");
      expect(sha256(prompt), name).toBe(expected[name as keyof typeof expected]);
    }
  });
});
