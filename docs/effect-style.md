# Effect style

Effect version: `4.0.0-rc` family (`effect`, `@effect/sql-pg`, `@effect/platform-node`, `@effect/ai-*`), pinned in lockstep. Every snippet below compiles against the pinned version. v3-era APIs (`Effect.Service`, `Context.GenericTag`, `Context.Tag`, `Effect.catchAll`, `Effect.zipRight`, `Schema.TaggedErrorClass`, the `yield* _(…)` adapter) do not exist here.

## The one test

At any function a reader must answer three questions without scrolling:

1. What does it produce?
2. How can it fail?
3. What does it need?

Effect encodes all three in `Effect<A, E, R>`. Style exists to keep that type honest and visible. Every rule below serves one of four readability failures: invisible wiring, dishonest error channels, combinator soup, or implicit semantics.

## Comments

No new comments. This includes JSDoc and doc-comments. Do not strip existing comments in unrelated diffs.

A "why" that no name or type can carry becomes one of:

1. A test named for the fact. Preferred: it is executable and fails when the reason stops being true.
2. An entry in `docs/` for architectural reasons (see `docs/durable-operations.md`).
3. A napkin/memory note for time-bombed workarounds.

If a "why" fits none of these, the code is probably doing something it should not.

## Two shapes of function

**Script** — anything with sequencing or branching. `Effect.gen`, reads like `async/await`.

```ts
const renameVault = (id: VaultId, name: string) =>
  Effect.gen(function* () {
    const vaults = yield* Vaults;
    const vault = yield* vaults.detail(id);
    const renamed = { ...vault, name };
    yield* vaults.save(renamed);
    return renamed;
  });
```

**Transform** — one value through at most three named steps. `pipe`.

```ts
const vaultDetail = (id: VaultId) =>
  loadVaultRow(id).pipe(Effect.map(toVaultDetail));
```

Never mix: no `pipe` chains inside a `gen` body beyond a single transform, no `flatMap` chains (that is a script pretending to be a transform), no nested `pipe`.

One or two steps with no branching: `Effect.map` / `Effect.flatMap`, not `gen`.

## Types

Fully annotate every method on a service shape. That interface is the documentation; it is where a reader goes to learn a service. The shape is named `XShape`; the class that carries the tag is `X`. Giving both the same name merges the interface into the class type and breaks `Layer.succeed(X, shape)`.

```ts
export interface VaultsShape {
  readonly detail: (id: VaultId) => Effect.Effect<VaultDetail, VaultNotFound>;
  readonly rename: (id: VaultId, name: string) => Effect.Effect<VaultDetail, VaultNotFound | Forbidden>;
  readonly list: (owner: UserId) => Effect.Effect<ReadonlyArray<VaultOverview>>;
}
```

Let `make` and internal helpers infer. Annotating implementations duplicates the interface and drifts.

Never escape a type with `as any` or `as unknown as`. If the type is wrong, fix the type.

## Errors

Three kinds, decided where the error is born.

**Domain errors** — expected, and a caller would plausibly branch on them. `Schema.TaggedError`, named as a fact, carrying the identifiers needed to act.

```ts
export class VaultNotFound extends Schema.TaggedError<VaultNotFound>()("VaultNotFound", {
  vaultId: VaultId,
}) {}
```

`Data.TaggedError` only for errors that are never serialized (never cross HTTP, a workflow journal, or storage).

**Defects** — bugs and infrastructure failures no caller at this level can recover from. Converted at the adapter (database, object store, HTTP client, mail) with `Effect.die` / `Effect.orDie`. They never appear in a signature.

```ts
const findVaultRow = (database: Database, id: VaultId) =>
  database.query((db) => db.select().from(vaults).where(eq(vaults.id, id))).pipe(
    Effect.orDie,
    Effect.flatMap((rows) => rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new VaultNotFound({ vaultId: id }))),
  );
```

**Interruption** — honored, never caught.

The test for `E`: if no caller would `catchTag` it, it is a defect. `E` lists only what a caller would plausibly handle. Infrastructure errors leaking into `E` and `orDie` inside business logic are both wrong.

Handling:

```ts
const detailOrDefault = (id: VaultId) =>
  vaults.detail(id).pipe(
    Effect.catchTag("VaultNotFound", () => Effect.succeed(defaultVaultDetail)),
  );
```

```ts
const toResponse = handler.pipe(
  Effect.catchTags({
    VaultNotFound: notFoundResponse,
    Forbidden: forbiddenResponse,
  }),
);
```

`Effect.catchCause` only at process edges (HTTP layer, workflow activity boundary) where defects are logged or mapped to 500.

Prefer a tagged error over `Option` when absence is exceptional to the caller. Use `Option` only when the caller's next step branches on absence (get-or-create, optional configuration).

## Services

One file, reading order: what it does → the key → how it is built → the layer.

```ts
export interface VaultsShape {
  readonly detail: (id: VaultId) => Effect.Effect<VaultDetail, VaultNotFound>;
  readonly rename: (id: VaultId, name: string) => Effect.Effect<VaultDetail, VaultNotFound | Forbidden>;
}

export class Vaults extends Context.Service<Vaults, VaultsShape>()("@great-minds/server/Vaults") {}

const makeVaults = Effect.gen(function* () {
  const database = yield* Database;
  const store = yield* ObjectStore;
  const access = yield* VaultAccess;

  const detail = (id: VaultId) =>
    Effect.gen(function* () {
      const row = yield* findVaultRow(database, id);
      const config = yield* store.readText(vaultConfigPath(id));
      return toVaultDetail(row, config);
    });

  const rename = (id: VaultId, name: string) =>
    Effect.gen(function* () {
      yield* access.requireOwner(id);
      const row = yield* findVaultRow(database, id);
      const updated = yield* updateVaultName(database, row, name);
      const config = yield* store.readText(vaultConfigPath(id));
      return toVaultDetail(updated, config);
    });

  return { detail, rename } satisfies VaultsShape;
});

export const VaultsLive = Layer.effect(Vaults, makeVaults);
```

Rules embedded in that shape:

- Dependencies are `yield*`'d at the top of `make`, never inside a method. Requesting a service inside a method moves the dependency from the service to every call site, which is the invisible-wiring problem.
- `make` is named `makeX` and is a plain `Effect.gen`. Do not inline it into `Layer.effect`.
- The layer is `XLive`. Test doubles are `XTest`.
- Methods are closures over the dependencies; helpers that need the dependencies take them as parameters.
- Code requests a service by its tag. Only composition roots and tests import `*Live`.

## Wiring

One composition root per process: `main.ts` for production, the harness for tests. Feature modules export `XLive` and never call `Layer.provide`.

The root is a flat, tiered list a reader can scan for "who provides `Database`":

```ts
const InfraLive = Layer.mergeAll(DatabaseLive, ObjectStoreLive, MailerLive).pipe(
  Layer.provide(ConfigLive),
);

const RepositoriesLive = Layer.mergeAll(VaultRowsLive, SourceRowsLive).pipe(
  Layer.provide(InfraLive),
);

const ServicesLive = Layer.mergeAll(VaultsLive, SourcesLive, RepliesLive).pipe(
  Layer.provide(RepositoriesLive),
  Layer.provide(InfraLive),
);

export const AppLive = HttpLive.pipe(Layer.provide(ServicesLive));
```

`Layer.provide` hides the dependency from consumers. `Layer.provideMerge` re-exports it; use it only when a downstream layer genuinely needs the same instance, and say so in the test that proves the instance is shared.

Periodic loops (reconcilers, reapers) are composed only in the production entrypoint so tests never run them.

## Boundaries

Decoding happens at HTTP handlers and storage reads. Core functions take refined values (`VaultId`, not `string`).

`Effect.runPromise` / `Effect.runPromiseExit` appear only at process entrypoints, the test harness, and the frontend query seam. A grep for `runPromise` returns a short, stable list.

## Implicit semantics, written down

Effect makes these configurable; the code states them.

Concurrency is always explicit:

```ts
const cards = yield* Effect.forEach(documents, extractCard, { concurrency: 4 });
```

Resources are acquired in a visibly scoped block:

```ts
const withConnection = Effect.acquireRelease(openConnection, (connection) => connection.close).pipe(
  Effect.flatMap(useConnection),
  Effect.scoped,
);
```

Forked fibers state their owner by where they are forked: `Effect.forkScoped` inside the scope that owns them, never a bare `Effect.fork` in a helper.

Retries name their policy as a constant with a domain name and state their bound:

```ts
const providerRetry = { schedule: Schedule.exponential("500 millis"), times: 3 } as const;

const completion = yield* callProvider(request).pipe(Effect.retry(providerRetry));
```

Deliberately unhandled errors and cooperative-interruption guards are proven by a test named for the fact, not explained inline.

## Naming

- Effects: verb phrase or outcome noun — `loadVault`, `vaultDetail`. Never suffixed `Effect`.
- Errors: facts — `VaultNotFound`, `ReplyInterrupted`, `SourceConflict`. Not categories (`DbError`, `NotFoundError`).
- Layers: `XLive`, `XTest`.
- Tags: `@great-minds/<package>/<Service>`.
- Schemas and their types share a name.
- Workflow activities include their occurrence (cursor, index) in the name.
- No single-letter names outside a one-line lambda.

## Extraction

Extract a step when it has a name a reviewer would use in a review comment. Do not extract to hit a line count. Five inline lines with a well-named intermediate beat a one-use helper the reader has to jump to.

## Tests

Build the test layer once per file. Observe failures as data with `Effect.exit`; assert on `_tag`, never on message text.

```ts
const outcome = yield* Effect.exit(vaults.detail(missingId));
assert(Exit.isFailure(outcome));
```

`Effect.exit` captures typed failures and defects. Use it whenever the test must distinguish the two.

## Ban list

- Nested `pipe`
- Point-free composition (`flow`, curried combinators with no lambda and no named function)
- `flatMap` chains
- `orDie` / `catchCause` outside adapters and process edges
- Swallowing errors without a domain reason
- `Option` where a domain error says more
- `as any`, `as unknown as`
- `runPromise` mid-module
- `Layer.provide` in a feature module
- `yield* Dep` inside a method body
- The `yield* _(…)` adapter
- New comments of any kind
- Restating an interface's types on its implementation
