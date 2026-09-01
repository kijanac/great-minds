import { describe, it } from "node:test";

import { RuleTester } from "oxlint/plugins-dev";

import plugin from "./boundary-plugin.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

type LibraryRule = Parameters<InstanceType<typeof RuleTester>["run"]>[1];
const asLibraryRule = (rule: (typeof plugin.rules)[string]) => rule as unknown as LibraryRule;

tester.run(
  "boundary/no-alternate-key-probing",
  asLibraryRule(plugin.rules["no-alternate-key-probing"]!),
  {
    valid: [
      'for (const key of ["a", "b"]) { console.log(key); }',
      'for (const key of ["a"]) { record[key]; }',
      "for (const key of keys) { record[key]; }",
      'for (const item of [1, 2]) { record[item]; }',
      'const record = {}; for (const key of ["a", "b"]) { other["fixed"]; }',
    ],
    invalid: [
      {
        code: 'for (const key of ["total_cost", "cost", "cost_usd"]) { const v = record[key]; if (v !== undefined) break; }',
        errors: 1,
      },
      {
        code: 'for (const spelling of ["a", "b"]) { if (use(record[spelling])) return; }',
        errors: 1,
      },
    ],
  },
);

tester.run("boundary/no-unknown-record-cast", asLibraryRule(plugin.rules["no-unknown-record-cast"]!), {
  valid: [
    "const a = value as Record<string, string>;",
    "const a = value as Record<number, unknown>;",
    "const a: Record<string, unknown> = {};",
    "const a = value as SomethingElse<string, unknown>;",
  ],
  invalid: [
    { code: "const a = value as Record<string, unknown>;", errors: 1 },
    { code: "const b = (json as Record<string, unknown>).field;", errors: 1 },
  ],
});
