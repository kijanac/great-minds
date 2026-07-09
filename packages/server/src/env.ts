import { readFileSync } from "node:fs";
import { join } from "node:path";

const parseDotEnv = () => {
  try {
    const text = readFileSync(join(process.cwd(), ".env"), "utf8");
    const entries = new Map<string, string>();
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const equals = line.indexOf("=");
      if (equals === -1) {
        continue;
      }
      const key = line.slice(0, equals).trim();
      let value = line.slice(equals + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      entries.set(key, value);
    }
    return entries;
  } catch {
    return new Map<string, string>();
  }
};

const dotEnv = parseDotEnv();

export const readEnv = (name: string) => process.env[name] ?? dotEnv.get(name);

export const requireEnv = (name: string) => {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};
