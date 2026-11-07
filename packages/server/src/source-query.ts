import { Database, sourceDocuments } from "@great-minds/database";
import { BadRequest, type SourceQuery, type Uuid } from "@great-minds/domain";
import { and, asc, eq, ilike, sql, type SQL } from "drizzle-orm";
import { Effect } from "effect";

import type { VaultConfigFile } from "./vault-config.ts";

export const tagCondition = (tag: string) =>
  sql`exists (select 1 from unnest(${sourceDocuments.tags}) as tag_value where lower(tag_value) = lower(${tag}))`;

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

const datePrefix = sql`substring(${sourceDocuments.publishedDate} from '^[0-9]{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12][0-9]|3[01]))?)?')`;

const dateBound = (bound: string, direction: ">=" | "<=") => {
  const width = sql`least(length(${datePrefix}), ${sql.raw(String(bound.length))})`;
  return sql`left(${datePrefix}, ${width}) ${sql.raw(direction)} left(${bound}, ${width})`;
};

const fieldCondition = (
  config: VaultConfigFile,
  name: string,
  value: string,
): Effect.Effect<SQL, BadRequest> => {
  const field = config.enrichedFields.find((candidate) => candidate.name === name);
  if (field === undefined) {
    const known = config.enrichedFields.map((candidate) => candidate.name);
    return Effect.fail(
      new BadRequest({
        detail:
          known.length === 0
            ? `Unknown metadata field "${name}": this vault declares no metadata fields.`
            : `Unknown metadata field "${name}": this vault's fields are ${known.join(", ")}.`,
      }),
    );
  }
  const stored = sql`${sourceDocuments.derivedExtras} -> ${name}`;
  return Effect.succeed(
    field.type === "list"
      ? sql`exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(${stored}) = 'array' then ${stored} else '[]'::jsonb end) as field_value where lower(field_value) = lower(${value}))`
      : sql`lower(${sourceDocuments.derivedExtras} ->> ${name}) = lower(${value})`,
  );
};

const sortOrder = (sort: SourceQuery["sort"]) => {
  switch (sort) {
    case "title":
      return [sql`lower(${sourceDocuments.title}) asc nulls last`, asc(sourceDocuments.id)];
    case "date_desc":
      return [sql`${datePrefix} desc nulls last`, asc(sourceDocuments.id)];
    case "date":
    case undefined:
      return [sql`${datePrefix} asc nulls last`, asc(sourceDocuments.id)];
  }
};

export const querySourceRows = (
  db: Database["Service"],
  vaultId: Uuid,
  config: VaultConfigFile,
  query: SourceQuery,
  defaultLimit: number,
) =>
  Effect.gen(function* () {
    const conditions: SQL[] = [eq(sourceDocuments.vaultId, vaultId)];
    for (const tag of query.tags ?? []) conditions.push(tagCondition(tag));
    if (query.author !== undefined && query.author !== "")
      conditions.push(ilike(sourceDocuments.author, likePattern(query.author)));
    if (query.genre !== undefined && query.genre !== "")
      conditions.push(sql`lower(${sourceDocuments.genre}) = lower(${query.genre})`);
    if (query.date_from !== undefined) conditions.push(dateBound(query.date_from, ">="));
    if (query.date_to !== undefined) conditions.push(dateBound(query.date_to, "<="));
    for (const [name, value] of Object.entries(query.fields ?? {}))
      conditions.push(yield* fieldCondition(config, name, value));
    const where = and(...conditions);
    const limit = query.limit ?? defaultLimit;
    const offset = query.offset ?? 0;
    const [counted] = yield* db.query((d) =>
      d
        .select({ total: sql<number>`count(*)::int` })
        .from(sourceDocuments)
        .where(where),
    );
    const rows = yield* db.query((d) =>
      d
        .select()
        .from(sourceDocuments)
        .where(where)
        .orderBy(...sortOrder(query.sort))
        .limit(limit)
        .offset(offset),
    );
    return { rows, total: counted?.total ?? 0, limit, offset };
  });
