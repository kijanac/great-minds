import { createHash } from "node:crypto";

import { BadRequest, Uuid as UuidSchema, type Uuid } from "@great-minds/domain";
import { Effect, Schema } from "effect";

import { parseFrontmatter, serializeFrontmatter } from "./markdown.ts";

declare const CanonicalSourceUrlBrand: unique symbol;

export type CanonicalSourceUrl = string & {
  readonly [CanonicalSourceUrlBrand]: true;
};

const decodeUuid = Schema.decodeUnknownSync(UuidSchema);

export const parseCanonicalSourceUrl = (
  rawUrl: string,
): Effect.Effect<CanonicalSourceUrl, BadRequest> =>
  Effect.try({
    try: () => {
      const trimmed = rawUrl.trim();
      const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("URL must use HTTP or HTTPS");
      }
      if (parsed.username !== "" || parsed.password !== "") {
        throw new Error("URL credentials are not supported");
      }
      parsed.hash = "";
      return parsed.href as CanonicalSourceUrl;
    },
    catch: (error) =>
      new BadRequest({
        detail: `Invalid source URL: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

export const sourceIdForKey = (vaultId: Uuid, key: string): Uuid => {
  const bytes = createHash("sha256").update(vaultId).update("\0").update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as Uuid;
};

export const sourceIdentityFromFrontmatter = (
  frontmatter: Readonly<Record<string, unknown>>,
) => ({
  sourceId: decodeUuid(frontmatter.source_id),
  canonicalUrl:
    frontmatter.canonical_url === undefined
      ? null
      : Schema.decodeUnknownSync(Schema.String)(frontmatter.canonical_url),
});

export const identifySourceMarkdown = (
  content: string,
  sourceId: Uuid,
  canonicalUrl: CanonicalSourceUrl | null = null,
) => {
  const parsed = parseFrontmatter(content);
  const { source_id: _sourceId, canonical_url: _canonicalUrl, ...frontmatter } =
    parsed.frontmatter;
  return serializeFrontmatter(
    {
      source_id: sourceId,
      ...(canonicalUrl === null ? {} : { canonical_url: canonicalUrl }),
      ...frontmatter,
    },
    parsed.body,
  );
};
