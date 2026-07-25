import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

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

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

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
      "cleanup.md": "3bc29dd1ab747ec40dbf19d317b193955819714823a0074399a1f01f2c7d48ca",
      "extract.md": "0d589c31e7c6413e4aaaea6f70b36d9c36a8a81aa2bfc024477779e4f3c62dda",
      "query.md": "d02c29eb9d1367ef61e230741aee22feb3a2dea6564956ff2a433a34c876afee",
      "query_btw.md": "1415f3050b8c6b36867f2f0390281c775a3103991a6ad5a3e296fd7d42cdc138",
      "render.md": "3d0db999681198d4d7f1a6c02adc91a9e4d8ef58e91fc8929981d3792aebd0bf",
      "synthesize.md": "9b122a4e2f11e9fb83428c321cb2cc70315105ca2660e350babc573bc72370bf",
      "synthesize_decompose.md":
        "74301aece5c13aa01e94d14db1a24f66a2d6ff8458035c2e13e79e1f95195f3a",
      "synthesize_revise.md":
        "c058afbc1c98fedcba67b65aed1b5b8a32b1615c607eef079ebb5876663cebcf",
    } as const;
    const names = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
    expect(names).toEqual(Object.keys(expected));
    for (const name of names) {
      const prompt = await readFile(new URL(name, directory), "utf8");
      expect(sha256(prompt), name).toBe(expected[name as keyof typeof expected]);
    }
  });
});
