import { backlinks, wikiArticles } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq, ne, sql } from "drizzle-orm";

const WIKI_INDEX_PATH = "wiki/_index.md";

export const liveArticleConditions = (vaultId: Uuid) => [
  eq(wikiArticles.vaultId, vaultId),
  eq(wikiArticles.archived, false),
  ne(wikiArticles.filePath, WIKI_INDEX_PATH),
];

export const liveInboundLinks = sql<number>`(select count(*)::int from ${backlinks} join ${wikiArticles} as linking on linking.id = ${backlinks.sourceArticleId} where ${backlinks.targetArticleId} = ${wikiArticles.id} and not linking.archived)`;
