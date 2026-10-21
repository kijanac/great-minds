import { posix } from "node:path";

import {
  Database,
  type DatabaseInfraError,
  type TransactionClient,
  searchIndex,
  sourceDocuments,
  sourceIncarnations,
} from "@great-minds/database";
import { Conflict, SessionId, type FileFingerprint, type Uuid } from "@great-minds/domain";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Cause, Context, Data, Effect, Exit, Layer, Schema } from "effect";

import { backgroundLoop } from "./background-loop.ts";
import { bodyContentHash, fileContentHash } from "./crypto.ts";
import { parseFrontmatter, serializeFrontmatter } from "./markdown.ts";
import { StructuredLogger } from "./logging.ts";
import {
  encodeSourceControl,
  readSourceControl,
  sourceIdentityFromFrontmatter,
} from "./source-identity.ts";
import { ContentStorage, StorageFileMissing, vaultOwner } from "./storage.ts";

type SourceDocumentRow = typeof sourceDocuments.$inferSelect;
type SourceIncarnationRow = typeof sourceIncarnations.$inferSelect;
type SourceMarkdown = ReturnType<typeof parseFrontmatter>;

export type SourceAdmission = Pick<
  SourceDocumentRow,
  "id" | "vaultId" | "incarnationId" | "filePath"
>;
export type SourceSnapshot = SourceAdmission & Pick<SourceDocumentRow, "bodyHash" | "fileHash">;

class SourceRegistryConflict extends Data.TaggedError("SourceRegistryConflict")<{
  readonly message: string;
}> {}

type SourceDocumentsServiceShape = {
  readonly admit: (
    vaultId: Uuid,
    sourceId: Uuid,
    filePath: string,
  ) => Effect.Effect<SourceAdmission>;
  readonly admission: (
    vaultId: Uuid,
    incarnationId: Uuid,
  ) => Effect.Effect<SourceAdmission, Conflict>;
  readonly write: (
    admission: SourceAdmission,
    content: string,
    clientHash: FileFingerprint | null,
  ) => Effect.Effect<Uuid, Conflict>;
  readonly discover: (vaultId: Uuid) => Effect.Effect<readonly DiscoveredSource[]>;
  readonly readCurrent: (
    source: SourceSnapshot,
  ) => Effect.Effect<SourceMarkdown | undefined, StorageFileMissing>;
  readonly rewrite: <R>(
    source: SourceDocumentRow,
    transform: (markdown: SourceMarkdown) => SourceMarkdown,
    project: (tx: TransactionClient) => Effect.Effect<void, DatabaseInfraError, R>,
  ) => Effect.Effect<boolean, StorageFileMissing, R>;
  readonly withCurrent: <R>(
    source: SourceSnapshot,
    project: (tx: TransactionClient) => Effect.Effect<void, DatabaseInfraError, R>,
  ) => Effect.Effect<boolean, never, R>;
  readonly existingClientHashes: (
    vaultId: Uuid,
    clientHashes: readonly FileFingerprint[],
  ) => Effect.Effect<readonly FileFingerprint[]>;
  readonly getById: (vaultId: Uuid, sourceId: Uuid) => Effect.Effect<SourceDocumentRow | undefined>;
  readonly getByPath: (
    vaultId: Uuid,
    filePath: string,
  ) => Effect.Effect<SourceDocumentRow | undefined>;
  readonly deleteSource: (
    vaultId: Uuid,
    sourceId: Uuid,
    incarnationId?: Uuid,
  ) => Effect.Effect<boolean>;
  readonly reconcileDeletionsOnce: () => Effect.Effect<number>;
};

export class SourceDocumentsService extends Context.Service<
  SourceDocumentsService,
  SourceDocumentsServiceShape
>()("@great-minds/server/SourceDocumentsService") {}

const stringField = (frontmatter: Record<string, unknown>, key: string) => {
  const value = frontmatter[key];
  return typeof value === "string" ? value : null;
};

const documentTitle = (body: string) =>
  /^#\s+(.+?)(?:\s+\^p\d+)?\s*$/m.exec(body)?.[1]?.trim() ?? null;

const numberField = (frontmatter: Record<string, unknown>, key: string) => {
  const value = frontmatter[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    return Number.parseInt(value, 10);
  }
  return null;
};

const sourceFromMarkdown = (
  vaultId: Uuid,
  filePath: string,
  content: string,
  parsed: SourceMarkdown,
  clientHash: string | null,
) => {
  const identity = sourceIdentityFromFrontmatter(parsed.frontmatter);
  const provenanceSessionId = stringField(parsed.frontmatter, "session_id");
  return {
    id: identity.sourceId,
    incarnationId: identity.incarnationId,
    vaultId,
    filePath: posix.normalize(filePath),
    fileHash: fileContentHash(content),
    bodyHash: bodyContentHash(parsed.body),
    clientHash,
    sourceType: stringField(parsed.frontmatter, "source_type") ?? "document",
    url: stringField(parsed.frontmatter, "url"),
    canonicalUrl: identity.canonicalUrl,
    origin: stringField(parsed.frontmatter, "origin"),
    provenanceSessionId:
      provenanceSessionId === null
        ? null
        : Schema.decodeUnknownSync(SessionId)(provenanceSessionId),
    provenanceExchangeId: stringField(parsed.frontmatter, "exchange_id"),
    provenanceSessionQuery: stringField(parsed.frontmatter, "session_query"),
    provenanceSourceDocPath: stringField(parsed.frontmatter, "source_doc_path"),
    provenanceSourceAnchor: stringField(parsed.frontmatter, "source_anchor"),
    provenanceSourceParagraphIndex: numberField(parsed.frontmatter, "source_paragraph_index"),
    provenanceAnchoredTo: stringField(parsed.frontmatter, "anchored_to"),
    provenanceAnchoredSection: stringField(parsed.frontmatter, "anchored_section"),
    provenanceIntent: stringField(parsed.frontmatter, "intent"),
    title: documentTitle(parsed.body),
  };
};

export const parseSourceDocument = (
  vaultId: Uuid,
  filePath: string,
  content: string,
  clientHash: FileFingerprint | null = null,
) => sourceFromMarkdown(vaultId, filePath, content, parseFrontmatter(content), clientHash);

export type ParsedSourceDocument = Readonly<ReturnType<typeof parseSourceDocument>>;

const ownedSource = (
  admission: SourceAdmission,
  markdown: SourceMarkdown,
  clientHash: string | null,
) => {
  const parsed = {
    frontmatter: {
      ...markdown.frontmatter,
      source_id: admission.id,
      source_incarnation: admission.incarnationId,
    },
    body: markdown.body,
  };
  const content = serializeFrontmatter(parsed.frontmatter, parsed.body);
  return {
    content,
    source: {
      ...sourceFromMarkdown(admission.vaultId, admission.filePath, content, parsed, clientHash),
      incarnationId: admission.incarnationId,
    },
  };
};

type DiscoveredSource = {
  readonly source: SourceDocumentRow;
  readonly etag: string | null;
  readonly content?: string;
};

const admissionFields = {
  id: sourceIncarnations.sourceId,
  incarnationId: sourceIncarnations.id,
  vaultId: sourceIncarnations.vaultId,
  filePath: sourceIncarnations.filePath,
};

const lockSourceIdentity = (tx: TransactionClient, sourceId: Uuid) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`source-lifetime:${sourceId}`}, 0))`,
  );

export const admitSource = (
  tx: TransactionClient,
  vaultId: Uuid,
  sourceId: Uuid,
  filePath: string,
) =>
  Effect.gen(function* () {
    yield* lockSourceIdentity(tx, sourceId);
    const rows = yield* tx
      .insert(sourceIncarnations)
      .values({ sourceId, vaultId, filePath: posix.normalize(filePath) })
      .onConflictDoUpdate({
        target: sourceIncarnations.sourceId,
        targetWhere: sql`${sourceIncarnations.deletedAt} IS NULL`,
        set: { sourceId: sql`${sourceIncarnations.sourceId}` },
      })
      .returning(admissionFields);
    const admission = rows[0];
    if (admission === undefined || admission.vaultId !== vaultId) {
      return yield* Effect.die(
        new SourceRegistryConflict({
          message: "Source admission belongs to another vault or is missing",
        }),
      );
    }
    return admission;
  });

const sourceChanged = () =>
  new Conflict({
    detail: "The source was deleted, moved or changed while this operation was running",
  });

export const retainSource = (tx: TransactionClient, vaultId: Uuid, incarnationId: Uuid) =>
  Effect.gen(function* () {
    const rows = yield* tx
      .select(admissionFields)
      .from(sourceIncarnations)
      .where(
        and(
          eq(sourceIncarnations.id, incarnationId),
          eq(sourceIncarnations.vaultId, vaultId),
          isNull(sourceIncarnations.deletedAt),
        ),
      )
      .for("update");
    const source = rows[0];
    if (source === undefined) return yield* sourceChanged();
    return source;
  });

const ingestSet = {
  incarnationId: sql`excluded.incarnation_id`,
  filePath: sql`excluded.file_path`,
  fileHash: sql`excluded.file_hash`,
  bodyHash: sql`excluded.body_hash`,
  clientHash: sql`excluded.client_hash`,
  sourceType: sql`excluded.source_type`,
  etag: sql`excluded.etag`,
  url: sql`excluded.url`,
  canonicalUrl: sql`excluded.canonical_url`,
  origin: sql`excluded.origin`,
  provenanceSessionId: sql`excluded.provenance_session_id`,
  provenanceExchangeId: sql`excluded.provenance_exchange_id`,
  provenanceSessionQuery: sql`excluded.provenance_session_query`,
  provenanceSourceDocPath: sql`excluded.provenance_source_doc_path`,
  provenanceSourceAnchor: sql`excluded.provenance_source_anchor`,
  provenanceSourceParagraphIndex: sql`excluded.provenance_source_paragraph_index`,
  provenanceAnchoredTo: sql`excluded.provenance_anchored_to`,
  provenanceAnchoredSection: sql`excluded.provenance_anchored_section`,
  provenanceIntent: sql`excluded.provenance_intent`,
  title: sql`excluded.title`,
  updatedAt: sql`now()`,
};

const makeSourceDocuments = Effect.gen(function* () {
  const db = yield* Database;
  const storage = yield* ContentStorage;
  const logger = yield* StructuredLogger;

  const currentWhere = (source: SourceAdmission) =>
    and(
      eq(sourceIncarnations.id, source.incarnationId),
      eq(sourceIncarnations.sourceId, source.id),
      eq(sourceIncarnations.vaultId, source.vaultId),
      eq(sourceIncarnations.filePath, source.filePath),
      isNull(sourceIncarnations.deletedAt),
    );

  const currentIncarnation = (source: SourceAdmission) =>
    db
      .query((tx) => tx.select().from(sourceIncarnations).where(currentWhere(source)).limit(1))
      .pipe(Effect.map((rows) => rows[0]));

  const admission = (vaultId: Uuid, incarnationId: Uuid) =>
    db.transaction((tx) => retainSource(tx, vaultId, incarnationId));

  const withCurrent = <R>(
    source: SourceSnapshot,
    project: (tx: TransactionClient) => Effect.Effect<void, DatabaseInfraError, R>,
  ) =>
    db.transaction((tx) =>
      Effect.gen(function* () {
        const live = yield* tx
          .select({ id: sourceIncarnations.id })
          .from(sourceIncarnations)
          .where(currentWhere(source))
          .for("update");
        if (live.length === 0) return false;
        const rows = yield* tx
          .select({ id: sourceDocuments.id })
          .from(sourceDocuments)
          .where(
            and(
              eq(sourceDocuments.id, source.id),
              eq(sourceDocuments.incarnationId, source.incarnationId),
              eq(sourceDocuments.filePath, source.filePath),
              eq(sourceDocuments.bodyHash, source.bodyHash),
              eq(sourceDocuments.fileHash, source.fileHash),
            ),
          )
          .for("update");
        if (rows.length === 0) return false;
        yield* project(tx);
        return true;
      }),
    );

  const readVersioned = (vaultId: Uuid, filePath: string) =>
    storage
      .readVersionedText(vaultOwner(vaultId), filePath)
      .pipe(Effect.catchTag("StorageFileMissing", () => Effect.succeed(null)));

  const writableFile = (source: SourceAdmission) =>
    Effect.gen(function* () {
      if ((yield* currentIncarnation(source)) === undefined) return yield* sourceChanged();
      let file = yield* readVersioned(source.vaultId, source.filePath);
      if (file === null) {
        const reservation = encodeSourceControl({
          sourceId: source.id,
          incarnationId: source.incarnationId,
          state: "reserved",
        });
        yield* storage
          .writeTextIfVersion(vaultOwner(source.vaultId), source.filePath, null, reservation)
          .pipe(Effect.catchTag("ObjectVersionConflict", () => Effect.void));
        file = yield* readVersioned(source.vaultId, source.filePath);
      }
      if (file === null) return yield* sourceChanged();
      const current = yield* currentIncarnation(source);
      if (current === undefined) return yield* sourceChanged();
      const control = readSourceControl(file.content);
      const identity =
        control ?? sourceIdentityFromFrontmatter(parseFrontmatter(file.content).frontmatter);
      if (
        identity.sourceId !== source.id ||
        (control?.state === "deleted" && control.incarnationId === source.incarnationId)
      ) {
        return yield* sourceChanged();
      }
      if (
        identity.incarnationId !== source.incarnationId &&
        !(identity.incarnationId === null && current.unversioned)
      ) {
        const prior = yield* db.query((tx) =>
          tx
            .select({ id: sourceIncarnations.id, unversioned: sourceIncarnations.unversioned })
            .from(sourceIncarnations)
            .where(
              and(
                eq(sourceIncarnations.sourceId, source.id),
                eq(sourceIncarnations.vaultId, source.vaultId),
                isNotNull(sourceIncarnations.deletedAt),
                identity.incarnationId === null
                  ? undefined
                  : eq(sourceIncarnations.id, identity.incarnationId),
              ),
            ),
        );
        const recognized =
          identity.incarnationId === null
            ? prior.length === 0 || prior.some((row) => row.unversioned)
            : prior.length > 0;
        if (!recognized) return yield* sourceChanged();
      }
      return file;
    });

  const write = (source: SourceAdmission, content: string, clientHash: FileFingerprint | null) =>
    Effect.gen(function* () {
      const owned = ownedSource(source, parseFrontmatter(content), clientHash);
      const before = yield* getById(source.vaultId, source.id);
      const file = yield* writableFile(source);
      if (file.content !== owned.content) {
        yield* storage
          .writeTextIfVersion(
            vaultOwner(source.vaultId),
            source.filePath,
            file.version,
            owned.content,
          )
          .pipe(Effect.mapError(sourceChanged));
      }
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const live = yield* tx
            .select({ id: sourceIncarnations.id })
            .from(sourceIncarnations)
            .where(currentWhere(source))
            .for("update");
          if (live.length === 0) return yield* sourceChanged();
          const registered = yield* tx
            .select()
            .from(sourceDocuments)
            .where(eq(sourceDocuments.id, source.id))
            .for("update");
          const current = registered[0];
          if (
            current?.fileHash !== before?.fileHash ||
            current?.incarnationId !== before?.incarnationId ||
            current?.filePath !== before?.filePath
          ) {
            return yield* sourceChanged();
          }
          yield* tx
            .update(sourceIncarnations)
            .set({ unversioned: false })
            .where(eq(sourceIncarnations.id, source.incarnationId));
          const rows = yield* tx
            .insert(sourceDocuments)
            .values(owned.source)
            .onConflictDoUpdate({ target: sourceDocuments.id, set: ingestSet })
            .returning({ id: sourceDocuments.id });
          const written = rows[0];
          if (written === undefined)
            return yield* Effect.die(
              new SourceRegistryConflict({ message: "Source write returned no registry row" }),
            );
          return written.id;
        }),
      );
    });

  const readSnapshot = (source: SourceSnapshot) =>
    Effect.gen(function* () {
      const file = yield* readVersioned(source.vaultId, source.filePath);
      const current = yield* currentIncarnation(source);
      if (current === undefined) return;
      if (file === null) return yield* new StorageFileMissing({ path: source.filePath });
      const control = readSourceControl(file.content);
      if (control !== undefined) {
        if (control.sourceId === source.id && control.incarnationId === source.incarnationId) {
          return yield* new StorageFileMissing({ path: source.filePath });
        }
        return;
      }
      const parsed = parseFrontmatter(file.content);
      const identity = sourceIdentityFromFrontmatter(parsed.frontmatter);
      if (identity.sourceId !== source.id || bodyContentHash(parsed.body) !== source.bodyHash)
        return;
      if (
        identity.incarnationId !== source.incarnationId &&
        !(identity.incarnationId === null && current.unversioned)
      )
        return;
      return { file, parsed };
    });

  const rewrite = <R>(
    source: SourceDocumentRow,
    transform: (markdown: SourceMarkdown) => SourceMarkdown,
    project: (tx: TransactionClient) => Effect.Effect<void, DatabaseInfraError, R>,
  ) =>
    Effect.gen(function* () {
      const snapshot = yield* readSnapshot(source);
      if (snapshot === undefined) return false;
      const owned = ownedSource(source, transform(snapshot.parsed), source.clientHash);
      if (owned.content !== snapshot.file.content) {
        const written = yield* storage
          .writeTextIfVersion(
            vaultOwner(source.vaultId),
            source.filePath,
            snapshot.file.version,
            owned.content,
          )
          .pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
        if (!written) return false;
      }
      return yield* withCurrent(source, (tx) =>
        Effect.gen(function* () {
          yield* tx
            .update(sourceIncarnations)
            .set({ unversioned: false })
            .where(eq(sourceIncarnations.id, source.incarnationId));
          yield* tx
            .update(sourceDocuments)
            .set({
              fileHash: owned.source.fileHash,
              bodyHash: owned.source.bodyHash,
              etag: null,
              updatedAt: sql`now()`,
            })
            .where(eq(sourceDocuments.id, source.id));
          yield* project(tx);
        }),
      );
    });

  const refresh = (candidate: ParsedSourceDocument, expected: SourceDocumentRow | undefined) =>
    db.transaction((tx) =>
      Effect.gen(function* () {
        yield* lockSourceIdentity(tx, candidate.id);
        const history = yield* tx
          .select()
          .from(sourceIncarnations)
          .where(eq(sourceIncarnations.sourceId, candidate.id))
          .for("update");
        let live = history.find((row) => row.deletedAt === null);
        if (history.some((row) => row.vaultId !== candidate.vaultId)) {
          return yield* Effect.die(
            new SourceRegistryConflict({
              message: `Source ${candidate.id} belongs to another vault`,
            }),
          );
        }
        if (live === undefined) {
          if (history.length > 0) return;
          yield* tx
            .insert(sourceIncarnations)
            .values({
              ...(candidate.incarnationId === null ? {} : { id: candidate.incarnationId }),
              sourceId: candidate.id,
              vaultId: candidate.vaultId,
              filePath: candidate.filePath,
              unversioned: candidate.incarnationId === null,
            })
            .onConflictDoNothing();
          const rows = yield* tx
            .select()
            .from(sourceIncarnations)
            .where(
              and(
                eq(sourceIncarnations.sourceId, candidate.id),
                isNull(sourceIncarnations.deletedAt),
              ),
            )
            .for("update");
          live = rows[0];
          if (live === undefined || live.vaultId !== candidate.vaultId) return;
        }
        const existing = yield* tx
          .select()
          .from(sourceDocuments)
          .where(eq(sourceDocuments.id, candidate.id))
          .for("update");
        const current = existing[0];
        if (
          current?.fileHash !== expected?.fileHash ||
          current?.incarnationId !== expected?.incarnationId ||
          current?.filePath !== expected?.filePath
        )
          return;
        if (
          candidate.incarnationId !== live.id &&
          !(candidate.incarnationId === null && live.unversioned)
        ) {
          if (
            candidate.incarnationId !== null ||
            current !== undefined ||
            history.some((row) => row.deletedAt !== null)
          )
            return;
          yield* tx
            .update(sourceIncarnations)
            .set({ unversioned: true })
            .where(eq(sourceIncarnations.id, live.id));
        }
        const registered = yield* tx
          .select({ id: sourceDocuments.id })
          .from(sourceDocuments)
          .where(
            and(
              eq(sourceDocuments.vaultId, candidate.vaultId),
              eq(sourceDocuments.filePath, candidate.filePath),
            ),
          );
        if (registered.some((row) => row.id !== candidate.id)) {
          return yield* Effect.die(
            new SourceRegistryConflict({
              message: `Source identity mismatch at ${candidate.filePath}`,
            }),
          );
        }
        if (live.filePath !== candidate.filePath) {
          yield* tx
            .delete(searchIndex)
            .where(
              and(eq(searchIndex.vaultId, candidate.vaultId), eq(searchIndex.path, live.filePath)),
            );
        }
        if (
          live.filePath !== candidate.filePath ||
          (live.unversioned && candidate.incarnationId !== null)
        ) {
          yield* tx
            .update(sourceIncarnations)
            .set({
              filePath: candidate.filePath,
              ...(candidate.incarnationId === null ? {} : { unversioned: false }),
              updatedAt: sql`now()`,
            })
            .where(eq(sourceIncarnations.id, live.id));
        }
        const rows = yield* tx
          .insert(sourceDocuments)
          .values({
            ...candidate,
            incarnationId: live.id,
            clientHash: existing[0]?.clientHash ?? null,
          })
          .onConflictDoUpdate({ target: sourceDocuments.id, set: ingestSet })
          .returning();
        const row = rows[0];
        if (row === undefined)
          return yield* Effect.die(
            new SourceRegistryConflict({ message: "Discovered source returned no registry row" }),
          );
        return row;
      }),
    );

  const discover = (vaultId: Uuid) =>
    Effect.gen(function* () {
      const state = yield* db.query((tx) =>
        tx
          .select({ incarnation: sourceIncarnations, source: sourceDocuments })
          .from(sourceIncarnations)
          .leftJoin(sourceDocuments, eq(sourceDocuments.incarnationId, sourceIncarnations.id))
          .where(eq(sourceIncarnations.vaultId, vaultId)),
      );
      const history = new Map<Uuid, SourceIncarnationRow>();
      const retired = new Set<Uuid>();
      const retiredLegacyPaths = new Set<string>();
      const registered = new Map<string, SourceDocumentRow>();
      const registeredById = new Map<Uuid, SourceDocumentRow>();
      for (const row of state) {
        if (!history.has(row.incarnation.sourceId) || row.incarnation.deletedAt === null)
          history.set(row.incarnation.sourceId, row.incarnation);
        if (row.incarnation.deletedAt !== null) {
          retired.add(row.incarnation.sourceId);
          if (row.incarnation.unversioned)
            retiredLegacyPaths.add(`${row.incarnation.sourceId}\0${row.incarnation.filePath}`);
        }
        if (row.source !== null && row.incarnation.deletedAt === null) {
          registered.set(row.source.filePath, row.source);
          registeredById.set(row.source.id, row.source);
        }
      }
      const files = yield* storage.listMarkdown(vaultOwner(vaultId), "raw");
      const seen = new Map<Uuid, string>();
      type Candidate =
        | { readonly kind: "cached"; readonly etag: string; readonly source: SourceDocumentRow }
        | {
            readonly kind: "read";
            readonly etag: string | null;
            readonly source: ParsedSourceDocument;
            readonly content: string;
          };
      const candidates: Candidate[] = [];
      for (const file of files) {
        if (file.path.slice(file.path.lastIndexOf("/") + 1).startsWith("_")) continue;
        const prior = registered.get(file.path);
        let candidate: Candidate;
        if (prior !== undefined && file.etag !== null && file.etag === prior.etag) {
          candidate = { kind: "cached", etag: file.etag, source: prior };
        } else {
          const content = yield* storage
            .readText(vaultOwner(vaultId), file.path)
            .pipe(Effect.catchTag("StorageFileMissing", () => Effect.succeed(null)));
          if (content === null) continue;
          const source = parseSourceDocument(vaultId, file.path, content);
          const incarnation = history.get(source.id);
          if (incarnation !== undefined) {
            if (incarnation.deletedAt !== null) continue;
            if (
              source.incarnationId === null &&
              retiredLegacyPaths.has(`${source.id}\0${file.path}`) &&
              incarnation.filePath !== file.path &&
              registeredById.get(source.id)?.fileHash !== source.fileHash
            )
              continue;
            const unversioned =
              source.incarnationId === null &&
              (incarnation.unversioned ||
                (!retired.has(source.id) && !registeredById.has(source.id)));
            if (source.incarnationId !== incarnation.id && !unversioned) continue;
          }
          if (prior !== undefined && prior.id !== source.id) {
            return yield* Effect.die(
              new SourceRegistryConflict({
                message: `Source identity mismatch at ${file.path}: registered ${prior.id}, stored ${source.id}`,
              }),
            );
          }
          candidate = { kind: "read", etag: file.etag, source, content };
        }
        const earlier = seen.get(candidate.source.id);
        if (earlier !== undefined && earlier !== file.path) {
          return yield* Effect.die(
            new SourceRegistryConflict({
              message: `Source ${candidate.source.id} appears at both ${earlier} and ${file.path}`,
            }),
          );
        }
        seen.set(candidate.source.id, file.path);
        candidates.push(candidate);
      }
      const discovered: DiscoveredSource[] = [];
      for (const candidate of candidates) {
        if (candidate.kind === "cached") {
          discovered.push({ source: candidate.source, etag: candidate.etag });
        } else {
          const source = yield* refresh(candidate.source, registeredById.get(candidate.source.id));
          if (source !== undefined)
            discovered.push({ source, etag: candidate.etag, content: candidate.content });
        }
      }
      for (const source of registered.values()) {
        if (seen.get(source.id) === source.filePath) continue;
        yield* withCurrent(source, (tx) =>
          tx
            .delete(searchIndex)
            .where(and(eq(searchIndex.vaultId, vaultId), eq(searchIndex.path, source.filePath)))
            .pipe(Effect.asVoid),
        );
      }
      return discovered;
    });

  const retireFile = (deletion: SourceIncarnationRow) =>
    Effect.gen(function* () {
      if (deletion.unversioned) {
        const live = yield* db.query((tx) =>
          tx
            .select({ id: sourceIncarnations.id })
            .from(sourceIncarnations)
            .where(
              and(
                eq(sourceIncarnations.sourceId, deletion.sourceId),
                isNull(sourceIncarnations.deletedAt),
              ),
            )
            .limit(1),
        );
        if (live.length > 0) {
          const current = yield* getById(deletion.vaultId, deletion.sourceId);
          if (current === undefined) return false;
          if (
            !(yield* rewrite(
              current,
              (markdown) => markdown,
              () => Effect.void,
            ))
          )
            return false;
        }
      }
      const file = yield* readVersioned(deletion.vaultId, deletion.filePath);
      if (file !== null) {
        const control = readSourceControl(file.content);
        const identity =
          control ?? sourceIdentityFromFrontmatter(parseFrontmatter(file.content).frontmatter);
        if (identity.sourceId !== deletion.sourceId) return true;
        if (
          identity.incarnationId !== deletion.id &&
          !(identity.incarnationId === null && deletion.unversioned)
        )
          return true;
        if (control?.state === "deleted") return true;
      }
      const marker = encodeSourceControl({
        sourceId: deletion.sourceId,
        incarnationId: deletion.id,
        state: "deleted",
      });
      return yield* storage
        .writeTextIfVersion(
          vaultOwner(deletion.vaultId),
          deletion.filePath,
          file?.version ?? null,
          marker,
        )
        .pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
    });

  const cleanupDeletion = (deletion: SourceIncarnationRow) =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(retireFile(deletion));
      if (Exit.isFailure(result)) {
        if (result.cause.reasons.length > 0 && result.cause.reasons.every(Cause.isInterruptReason))
          return yield* Effect.interrupt;
        yield* logger.warn("source_deletion.storage_cleanup_deferred", {
          source_id: deletion.sourceId,
          incarnation_id: deletion.id,
          vault_id: deletion.vaultId,
          error_message: Cause.pretty(result.cause),
        });
      }
      const completed = Exit.isSuccess(result) && result.value;
      yield* db.query((tx) =>
        tx
          .update(sourceIncarnations)
          .set({
            attemptCount: sql`${sourceIncarnations.attemptCount} + 1`,
            lastAttemptAt: sql`now()`,
            ...(completed
              ? { completedAt: sql`coalesce(${sourceIncarnations.completedAt}, now())` }
              : {}),
            updatedAt: sql`now()`,
          })
          .where(
            and(eq(sourceIncarnations.id, deletion.id), isNotNull(sourceIncarnations.deletedAt)),
          ),
      );
      return completed;
    }).pipe(
      Effect.catchCause((cause) => {
        if (cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason))
          return Effect.interrupt;
        return logger
          .warn("source_deletion.reconciliation_deferred", {
            source_id: deletion.sourceId,
            incarnation_id: deletion.id,
            vault_id: deletion.vaultId,
            error_message: Cause.pretty(cause),
          })
          .pipe(Effect.as(false));
      }),
    );

  const getById = (vaultId: Uuid, sourceId: Uuid) =>
    db
      .query((tx) =>
        tx
          .select()
          .from(sourceDocuments)
          .where(and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.id, sourceId)))
          .limit(1),
      )
      .pipe(Effect.map((rows) => rows[0]));

  return {
    admit: (vaultId, sourceId, filePath) =>
      db.transaction((tx) => admitSource(tx, vaultId, sourceId, filePath)),
    admission,
    write,
    discover,
    readCurrent: (source) => readSnapshot(source).pipe(Effect.map((snapshot) => snapshot?.parsed)),
    rewrite,
    withCurrent,
    existingClientHashes: (vaultId, clientHashes) =>
      Effect.gen(function* () {
        if (clientHashes.length === 0) return [];
        const rows = yield* db.query((tx) =>
          tx
            .select({ clientHash: sourceDocuments.clientHash })
            .from(sourceDocuments)
            .where(
              and(
                eq(sourceDocuments.vaultId, vaultId),
                inArray(sourceDocuments.clientHash, [...clientHashes]),
              ),
            ),
        );
        return rows
          .map((row) => row.clientHash)
          .filter((hash): hash is string => hash !== null)
          .map((hash) => hash as FileFingerprint);
      }),
    getById,
    getByPath: (vaultId, filePath) =>
      db
        .query((tx) =>
          tx
            .select()
            .from(sourceDocuments)
            .where(
              and(
                eq(sourceDocuments.vaultId, vaultId),
                eq(sourceDocuments.filePath, posix.normalize(filePath)),
              ),
            )
            .limit(1),
        )
        .pipe(Effect.map((rows) => rows[0])),
    deleteSource: (vaultId, sourceId, incarnationId) =>
      Effect.gen(function* () {
        const deletion = yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const sourceRows = yield* tx
              .select()
              .from(sourceDocuments)
              .where(and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.id, sourceId)))
              .limit(1);
            const source = sourceRows[0];
            if (
              source === undefined ||
              (incarnationId !== undefined && source.incarnationId !== incarnationId)
            )
              return null;
            const live = yield* tx
              .select()
              .from(sourceIncarnations)
              .where(currentWhere(source))
              .for("update");
            const current = live[0];
            if (current === undefined) return null;
            const rows = yield* tx
              .update(sourceIncarnations)
              .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
              .where(eq(sourceIncarnations.id, current.id))
              .returning();
            const retired = rows[0];
            if (retired === undefined)
              return yield* Effect.die(
                new SourceRegistryConflict({ message: "Source deletion returned no incarnation" }),
              );
            yield* tx
              .delete(searchIndex)
              .where(and(eq(searchIndex.vaultId, vaultId), eq(searchIndex.path, current.filePath)));
            yield* tx
              .delete(sourceDocuments)
              .where(
                and(
                  eq(sourceDocuments.id, sourceId),
                  eq(sourceDocuments.incarnationId, current.id),
                ),
              );
            return retired;
          }),
        );
        if (deletion === null) return false;
        yield* cleanupDeletion(deletion);
        return true;
      }),
    reconcileDeletionsOnce: () =>
      Effect.gen(function* () {
        const rows = yield* db.query((tx) =>
          tx
            .select()
            .from(sourceIncarnations)
            .where(
              and(isNotNull(sourceIncarnations.deletedAt), isNull(sourceIncarnations.completedAt)),
            )
            .orderBy(asc(sourceIncarnations.deletedAt))
            .limit(100),
        );
        yield* Effect.forEach(rows, cleanupDeletion, { concurrency: 4 });
        return rows.length;
      }),
  } satisfies SourceDocumentsServiceShape;
});

export const SourceDocumentsServiceLive = Layer.effect(SourceDocumentsService, makeSourceDocuments);

export const SourceDeletionReconcilerLoopLive = Layer.effectDiscard(
  Effect.flatMap(SourceDocumentsService, (service) =>
    backgroundLoop({
      failureEvent: "source_deletion.reconciler_tick_failed",
      interval: "1 minute",
      tick: service.reconcileDeletionsOnce(),
    })),
);
