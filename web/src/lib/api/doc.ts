import {
  Uuid,
  type Chunk,
  type DocResponse,
  type LinkedArticles,
  type ReferenceOverview,
  type SourceDocument,
  type WikiArticle,
  type WikiArticleOverview,
} from "@great-minds/domain";
import { Schema } from "effect";

import { getVaultId } from "../vault-selection";

import { api, run } from "./app";

export type { Chunk, DocResponse, LinkedArticles, SourceDocument, WikiArticle };

export type DocChunk = Chunk;
export type LinkItem = WikiArticleOverview;
export type ReferenceArticle = ReferenceOverview & { kind: "reference" };
export type Article = SourceDocument | WikiArticle | ReferenceArticle;
export type DocumentScope = "vault" | "personal";
export type DocumentResponse =
  | DocResponse
  | {
      article: ReferenceArticle;
      body: string;
      archived: false;
      superseded_by: null;
    };

const uuid = Schema.decodeSync(Uuid);

function selectedVault(): Uuid {
  const id = getVaultId();
  if (id === null) throw new Error("No vault selected");
  return uuid(id);
}

export type ArticleMeta = {
  readonly title: string | null;
  readonly author: string | null;
  readonly published_date: string | null;
  readonly url: string | null;
  readonly origin: string | null;
  readonly genre: string | null;
  readonly precis: string | null;
  readonly source_type: string | null;
  readonly tags: readonly string[];
  readonly derived_extras: Readonly<Record<string, unknown>>;
};

export function articleMeta(article: Article): ArticleMeta {
  if (article.kind === "wiki") {
    return {
      title: article.title,
      author: null,
      published_date: null,
      url: null,
      origin: null,
      genre: null,
      precis: article.precis || null,
      source_type: null,
      tags: [],
      derived_extras: {},
    };
  }
  if (article.kind === "reference") {
    return {
      title: article.title,
      author: null,
      published_date: null,
      url: article.url,
      origin: article.origin,
      genre: null,
      precis: null,
      source_type: null,
      tags: [],
      derived_extras: {},
    };
  }
  return {
    title: article.title,
    author: article.author,
    published_date: article.published_date,
    url: article.url,
    origin: article.origin,
    genre: article.genre,
    precis: article.precis,
    source_type: article.source_type,
    tags: article.tags,
    derived_extras: article.derived_extras,
  };
}

export async function readDocument(path: string, signal?: AbortSignal): Promise<DocResponse> {
  return run(
    api.documents.resolveDocument({ params: { vault_id: selectedVault() }, query: { path } }),
    { signal },
  );
}

export async function readSourceDocument(
  sourceId: string,
  signal?: AbortSignal,
): Promise<DocResponse> {
  return run(
    api.sources.readSource({ params: { vault_id: selectedVault(), source_id: uuid(sourceId) } }),
    { signal },
  );
}

export async function readPersonalDocument(
  path: string,
  signal?: AbortSignal,
): Promise<DocumentResponse> {
  const data = await run(api.refs.resolveReference({ query: { path } }), { signal });
  return {
    article: { kind: "reference", ...data.reference },
    body: data.body,
    archived: false,
    superseded_by: null,
  };
}

export async function fetchChunks(
  path: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<readonly DocChunk[]> {
  return run(
    api.documents.readChunks({
      params: { vault_id: selectedVault() },
      query: { path, start, end },
    }),
    { signal },
  );
}

export async function fetchLinks(path: string, signal?: AbortSignal): Promise<LinkedArticles> {
  return run(api.documents.readLinks({ params: { vault_id: selectedVault() }, query: { path } }), {
    signal,
  });
}
