import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const inUuidArray = (column: AnyPgColumn, ids: readonly string[]): SQL =>
  sql`${column} = any(${sql.param(ids)}::uuid[])`;

export const uuidPairs = (left: readonly string[], right: readonly string[]): SQL =>
  sql`select * from unnest(${sql.param(left)}::uuid[], ${sql.param(right)}::uuid[])`;
