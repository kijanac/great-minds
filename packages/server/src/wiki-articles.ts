import { wikiArticles } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq, ne } from "drizzle-orm";

const WIKI_INDEX_PATH = "wiki/_index.md";

export const liveArticleConditions = (vaultId: Uuid) => [
  eq(wikiArticles.vaultId, vaultId),
  eq(wikiArticles.archived, false),
  ne(wikiArticles.filePath, WIKI_INDEX_PATH),
];
