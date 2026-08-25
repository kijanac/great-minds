import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const environmentDir = dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.GM_VERIFICATION_STATE_DIR ?? join(environmentDir, ".state");
const dataDir = process.env.DATA_DIR ?? join(stateDir, "data");
const apiBase = process.env.GM_VERIFICATION_API ?? "http://127.0.0.1:8000/v1";
const webBase = process.env.GM_VERIFICATION_WEB ?? "http://localhost:5173";
const fixtureBase = process.env.GM_VERIFICATION_FIXTURES ?? "http://127.0.0.1:4174";
const composeFile = join(environmentDir, "docker-compose.yml");
const sourceCommit = process.env.GM_EXPECTED_COMMIT ?? "c8c9e57";

const identities = {
  owner: { email: "owner.verify@example.test" },
  editor: { email: "editor.verify@example.test" },
  viewer: { email: "viewer.verify@example.test" },
  nonmember: { email: "nonmember.verify@example.test" },
};

const jsonRequest = async (method, path, { token, body, expected = [200] } = {}) => {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let decoded = null;
  if (text !== "") {
    try {
      decoded = JSON.parse(text);
    } catch {
      decoded = text;
    }
  }
  if (!expected.includes(response.status)) {
    const detail = typeof decoded === "string" ? decoded : JSON.stringify(decoded);
    throw new Error(`${method} ${path} returned ${response.status}: ${detail}`);
  }
  return decoded;
};

const jwtSubject = (accessToken) => {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) throw new Error("access token is not a JWT");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (typeof decoded.sub !== "string") throw new Error("JWT has no subject");
  return decoded.sub;
};

const signIn = async (email) => {
  await jsonRequest("POST", "/auth/request-code", {
    body: { email },
    expected: [200, 204],
  });
  const tokens = await jsonRequest("POST", "/auth/verify-code", {
    body: { email, code: "000000" },
    expected: [200],
  });
  return {
    email,
    user_id: jwtSubject(tokens.access_token),
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  };
};

const listVaults = (token) =>
  jsonRequest("GET", "/vaults?limit=200&offset=0", { token, expected: [200] });

const ensureVault = async (account, name, thematicHint) => {
  const listed = await listVaults(account.access_token);
  const existing = listed.items.find((vault) => vault.name === name);
  if (existing !== undefined) return existing;
  return jsonRequest("POST", "/vaults", {
    token: account.access_token,
    body: {
      name,
      thematic_hint: thematicHint,
      kinds: ["books", "articles", "reports", "notes"],
    },
    expected: [201],
  });
};

const ensureMembership = async (owner, vaultId, account, role) => {
  const page = await jsonRequest("GET", `/vaults/${vaultId}/members?limit=200&offset=0`, {
    token: owner.access_token,
    expected: [200],
  });
  const current = page.items.find((member) => member.email === account.email);
  if (current === undefined) {
    return jsonRequest("POST", `/vaults/${vaultId}/members`, {
      token: owner.access_token,
      body: { email: account.email, role },
      expected: [201],
    });
  }
  if (current.role !== role) {
    return jsonRequest("PUT", `/vaults/${vaultId}/members/${current.user_id}`, {
      token: owner.access_token,
      body: { role },
      expected: [200],
    });
  }
  return current;
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const stableUuid = (scope, label) => {
  const bytes = Buffer.from(sha256(`${scope}:${label}`).slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sqlTextArray = (values) => `ARRAY[${values.map(sqlLiteral).join(", ")}]::text[]`;

const writeFixture = async (root, relativePath, content) => {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return {
    path: relativePath,
    file_hash: sha256(content),
  };
};

const runSql = (sql) => {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      composeFile,
      "exec",
      "-T",
      "db",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "great_minds",
      "-d",
      "gm_product_verification",
    ],
    { input: sql, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`fixture SQL failed: ${result.stderr || result.stdout}`);
  }
};

const sourceDefinitions = [
  {
    key: "handbook",
    path: "raw/books/verification-handbook.md",
    sourceType: "book",
    title: "Verification Handbook",
    precis: "A stable source for checking grounded reading, evidence cards, and Library metadata.",
    author: "Ada Fixture",
    published: "2025-01-15",
    genre: "handbook",
    tags: ["verification", "research"],
    body: `# Verification Handbook

A verification claim should be observed in the running product before it is treated as confirmed. ^p0

## Grounding

Grounded answers should make their evidence inspectable and keep source scope intact. ^p1

## Interruptions

Leaving a page can stop observation without stopping durable background work. ^p2
`,
  },
  {
    key: "field-report",
    path: "raw/articles/field-report.md",
    sourceType: "article",
    title: "Field Report on Collective Research",
    precis: "A short field report with deliberately distinctive language for search checks.",
    author: "Mina Example",
    published: "2025-02-20",
    genre: "field report",
    tags: ["verification", "practice"],
    body: `# Field Report on Collective Research

The amber heron phrase exists only in this fixture, making literal search results easy to recognize. ^p0

Teams kept a shared record of claims, disagreements, and unresolved questions. ^p1
`,
  },
  {
    key: "untitled-notes",
    path: "raw/docs/untitled-notes.md",
    sourceType: "document",
    title: null,
    precis: null,
    author: null,
    published: null,
    genre: null,
    tags: [],
    body: `# Untitled notes fallback

This source deliberately has a null registry title so fallback behavior can be inspected. ^p0
`,
  },
];

const wikiDefinitions = [
  {
    key: "synthesis",
    path: "wiki/verification-synthesis.md",
    slug: "verification-synthesis",
    title: "Verification as observed evidence",
    precis: "Why source reading and product observation play different roles in verification.",
    description: "A synthesis of source-grounded and running-product evidence.",
    tags: ["verification", "theory"],
    body: `# Verification as observed evidence

Source code can establish durable state and likely causes, while the running interface establishes what a person can see and recover from. ^p0

A verification result therefore records both the visible outcome and its exact setup. ^p1

See [Grounded research practice](grounded-practice.md) for the companion workflow. ^p2
`,
  },
  {
    key: "practice",
    path: "wiki/grounded-practice.md",
    slug: "grounded-practice",
    title: "Grounded research practice",
    precis: "A compact workflow for moving from a source to an inspectable answer.",
    description: "A practical sequence for source-grounded research.",
    tags: ["verification", "practice"],
    body: `# Grounded research practice

Begin with a source, ask a bounded question, inspect the cited passage, and preserve uncertainty when generation is interrupted. ^p0

Return to [Verification as observed evidence](verification-synthesis.md) for the evidence model. ^p1
`,
  },
];

const seedContent = async (primaryVaultId, ownerUserId) => {
  const vaultRoot = join(dataDir, "vaults", primaryVaultId);
  const userRoot = join(dataDir, "users", ownerUserId);
  const sourceRows = [];
  const searchRows = [];

  for (const definition of sourceDefinitions) {
    const frontmatter = [
      "---",
      `source_type: ${definition.sourceType}`,
      ...(definition.title === null ? [] : [`title: ${definition.title}`]),
      "origin: verification fixture",
      "---",
      "",
    ].join("\n");
    const content = `${frontmatter}${definition.body}`;
    const written = await writeFixture(vaultRoot, definition.path, content);
    const id = stableUuid(primaryVaultId, `source:${definition.key}`);
    sourceRows.push({ ...definition, ...written, id, content });
    searchRows.push({
      path: definition.path,
      heading: definition.title ?? "Untitled notes fallback",
      body: definition.body,
      contentHash: sha256(definition.body),
    });
  }

  const wikiRows = [];
  for (const definition of wikiDefinitions) {
    const topicId = stableUuid(primaryVaultId, `topic:${definition.key}`);
    const articleId = stableUuid(primaryVaultId, `article:${definition.key}`);
    const content = `---\ntitle: ${definition.title}\nprecis: ${definition.precis}\ntags:\n${definition.tags.map((tag) => `  - ${tag}`).join("\n")}\n---\n\n${definition.body}`;
    const written = await writeFixture(vaultRoot, definition.path, content);
    wikiRows.push({ ...definition, ...written, topicId, articleId, content });
    searchRows.push({
      path: definition.path,
      heading: definition.title,
      body: definition.body,
      contentHash: sha256(definition.body),
    });
  }

  const referencePath = "refs/verification-reference.md";
  const referenceTitle = "Personal verification reference";
  const referenceBody = `# Personal verification reference

This sentence is private to the owner's reading room and contains the silver kingfisher phrase. ^p0

A personal reference should retain personal scope when it starts a query or anchored note. ^p1
`;
  const referenceContent = `---\nsource_type: document\nurl: ${fixtureBase}/article\norigin: 127.0.0.1:4174\n---\n${referenceBody}`;
  const referenceWritten = await writeFixture(userRoot, referencePath, referenceContent);
  const referenceId = stableUuid(ownerUserId, "reference:verification");

  const sourceValues = sourceRows
    .map(
      (row) => `(
        ${sqlLiteral(row.id)}, ${sqlLiteral(primaryVaultId)}, ${sqlLiteral(row.path)},
        ${sqlLiteral(row.file_hash)}, ${sqlLiteral(sha256(row.body))}, ${sqlLiteral(row.sourceType)},
        'verification fixture', ${row.title === null ? "NULL" : sqlLiteral(row.title)},
        ${row.precis === null ? "NULL" : sqlLiteral(row.precis)},
        ${row.author === null ? "NULL" : sqlLiteral(row.author)},
        ${row.published === null ? "NULL" : sqlLiteral(row.published)},
        ${row.genre === null ? "NULL" : sqlLiteral(row.genre)}, ${sqlTextArray(row.tags)}, '{}'::jsonb
      )`,
    )
    .join(",\n");

  const topicValues = wikiRows
    .map(
      (row) => `(
        ${sqlLiteral(row.topicId)}, ${sqlLiteral(primaryVaultId)}, ${sqlLiteral(row.slug)},
        ${sqlLiteral(row.title)}, ${sqlLiteral(row.description)}, 'rendered',
        ${sqlLiteral(row.file_hash)}, ${sqlLiteral(row.file_hash)}
      )`,
    )
    .join(",\n");

  const articleValues = wikiRows
    .map(
      (row) => `(
        ${sqlLiteral(row.articleId)}, ${sqlLiteral(primaryVaultId)}, ${sqlLiteral(row.topicId)},
        ${sqlLiteral(row.path)}, ${sqlLiteral(row.file_hash)}, ${sqlLiteral(sha256(row.body))},
        ${sqlLiteral(row.title)}, ${sqlLiteral(row.precis)}, false, ${sqlTextArray(row.tags)}
      )`,
    )
    .join(",\n");

  const searchValues = searchRows
    .map(
      (row, index) => `(
        ${sqlLiteral(primaryVaultId)}, ${sqlLiteral(row.path)}, 0, ${sqlLiteral(row.heading)},
        ${sqlLiteral(row.body)}, ${sqlLiteral(`${row.contentHash}-${index}`)},
        to_tsvector('english', ${sqlLiteral(`${row.heading}\n${row.body}`)})
      )`,
    )
    .join(",\n");

  const [synthesis, practice] = wikiRows;
  if (synthesis === undefined || practice === undefined) throw new Error("wiki fixtures missing");

  runSql(`
BEGIN;

INSERT INTO source_documents (
  id, vault_id, file_path, file_hash, body_hash, source_type, origin,
  title, precis, author, published_date, genre, tags, derived_extras
) VALUES
${sourceValues}
ON CONFLICT (vault_id, file_path) DO UPDATE SET
  file_hash = EXCLUDED.file_hash,
  body_hash = EXCLUDED.body_hash,
  source_type = EXCLUDED.source_type,
  origin = EXCLUDED.origin,
  title = EXCLUDED.title,
  precis = EXCLUDED.precis,
  author = EXCLUDED.author,
  published_date = EXCLUDED.published_date,
  genre = EXCLUDED.genre,
  tags = EXCLUDED.tags,
  derived_extras = EXCLUDED.derived_extras,
  updated_at = now();

INSERT INTO topics (
  topic_id, vault_id, slug, title, description, article_status,
  compiled_from_hash, rendered_from_hash
) VALUES
${topicValues}
ON CONFLICT (vault_id, slug) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  article_status = EXCLUDED.article_status,
  compiled_from_hash = EXCLUDED.compiled_from_hash,
  rendered_from_hash = EXCLUDED.rendered_from_hash,
  updated_at = now();

INSERT INTO wiki_articles (
  id, vault_id, topic_id, file_path, file_hash, body_hash,
  title, precis, archived, tags
) VALUES
${articleValues}
ON CONFLICT (topic_id) DO UPDATE SET
  file_path = EXCLUDED.file_path,
  file_hash = EXCLUDED.file_hash,
  body_hash = EXCLUDED.body_hash,
  title = EXCLUDED.title,
  precis = EXCLUDED.precis,
  archived = EXCLUDED.archived,
  tags = EXCLUDED.tags,
  updated_at = now();

INSERT INTO topic_links (source_topic_id, target_topic_id) VALUES
  (${sqlLiteral(synthesis.topicId)}, ${sqlLiteral(practice.topicId)}),
  (${sqlLiteral(practice.topicId)}, ${sqlLiteral(synthesis.topicId)})
ON CONFLICT DO NOTHING;

INSERT INTO backlinks (source_article_id, target_article_id) VALUES
  (${sqlLiteral(synthesis.articleId)}, ${sqlLiteral(practice.articleId)}),
  (${sqlLiteral(practice.articleId)}, ${sqlLiteral(synthesis.articleId)})
ON CONFLICT DO NOTHING;

DELETE FROM search_index
WHERE vault_id = ${sqlLiteral(primaryVaultId)}
  AND path IN (${searchRows.map((row) => sqlLiteral(row.path)).join(", ")});

INSERT INTO search_index (
  vault_id, path, chunk_index, heading, body, content_hash, tsv
) VALUES
${searchValues};

INSERT INTO user_documents (
  id, user_id, file_path, file_hash, body_hash, title, url, origin, author, published
) VALUES (
  ${sqlLiteral(referenceId)}, ${sqlLiteral(ownerUserId)}, ${sqlLiteral(referencePath)},
  ${sqlLiteral(referenceWritten.file_hash)}, ${sqlLiteral(sha256(referenceBody))},
  ${sqlLiteral(referenceTitle)}, ${sqlLiteral(`${fixtureBase}/article`)},
  '127.0.0.1:4174', 'Fixture Author', '2025-03-04'
)
ON CONFLICT (user_id, file_path) DO UPDATE SET
  file_hash = EXCLUDED.file_hash,
  body_hash = EXCLUDED.body_hash,
  title = EXCLUDED.title,
  url = EXCLUDED.url,
  origin = EXCLUDED.origin,
  author = EXCLUDED.author,
  published = EXCLUDED.published,
  updated_at = now();

COMMIT;
`);

  return {
    sources: sourceRows.map(({ id, path, title, sourceType, tags }) => ({
      id,
      path,
      title,
      source_type: sourceType,
      tags,
    })),
    articles: wikiRows.map(({ articleId, topicId, path, title, tags }) => ({
      id: articleId,
      topic_id: topicId,
      path,
      title,
      tags,
    })),
    reference: {
      id: referenceId,
      path: referencePath,
      title: referenceTitle,
    },
  };
};

const ensureSessions = async (owner, primaryVaultId) => {
  const listed = await jsonRequest("GET", `/vaults/${primaryVaultId}/sessions?limit=200&offset=0`, {
    token: owner.access_token,
    expected: [200],
  });

  const mainQuery = "How should this verification vault be used?";
  let main = listed.items.find((item) => item.query === mainQuery);
  if (main === undefined) {
    main = await jsonRequest("POST", `/vaults/${primaryVaultId}/sessions`, {
      token: owner.access_token,
      body: {
        idempotency_key: "verification-main-session-v1",
        exchange: {
          id: "ex-verification-main",
          query: mainQuery,
          thinking: [
            {
              sources: [
                {
                  label: "Verification Handbook",
                  type: "raw",
                  title: "Verification Handbook",
                  scope: "kb",
                  path: "raw/books/verification-handbook.md",
                  thinking: "Read the fixture's grounding and interruption claims.",
                  ranges: [{ start: 0, end: 0 }],
                  full: false,
                },
                {
                  label: "Verification as observed evidence",
                  type: "article",
                  title: "Verification as observed evidence",
                  scope: "kb",
                  path: "wiki/verification-synthesis.md",
                  thinking: "Connect source inspection with visible-product observation.",
                  ranges: [{ start: 0, end: 0 }],
                  full: false,
                },
              ],
            },
          ],
          answer:
            "Use it as a disposable workspace: inspect evidence, interrupt work, change scope, and record only what the running product actually shows.",
        },
      },
      expected: [201],
    });

    await jsonRequest("PATCH", `/vaults/${primaryVaultId}/sessions/${main.id}/btw`, {
      token: owner.access_token,
      body: {
        quote: "record only what the running product actually shows",
        blockOffset: 0,
        context:
          "Use it as a disposable workspace: inspect evidence, interrupt work, change scope, and record only what the running product actually shows.",
        exchangeId: "ex-verification-main",
        exchanges: [
          {
            query: "Why is source reading not enough?",
            thinking: [],
            answer:
              "Source reading predicts behavior; hand verification establishes the visible outcome.",
          },
        ],
      },
      expected: [200],
    });

    await jsonRequest("PATCH", `/vaults/${primaryVaultId}/sessions/${main.id}`, {
      token: owner.access_token,
      body: {
        id: "ex-verification-follow-up",
        query: "What should be recorded after a failure?",
        thinking: [],
        answer:
          "Record the setup, exact visible result, recovery path, and matching triage identifier.",
      },
      expected: [200],
    });
  }

  const referenceQuery = "Why does the silver kingfisher phrase matter?";
  let referenceNote = listed.items.find((item) => item.query === referenceQuery);
  if (referenceNote === undefined) {
    referenceNote = await jsonRequest("POST", `/vaults/${primaryVaultId}/sessions`, {
      token: owner.access_token,
      body: {
        idempotency_key: "verification-personal-reference-note-v1",
        exchange: {
          id: "ex-verification-reference-note",
          query: referenceQuery,
          thinking: [],
          answer: "It is unique to the personal reference and makes a scope leak observable.",
        },
        origin: {
          doc_path: "refs/verification-reference.md",
          origin_scope: "personal",
          anchor: "silver kingfisher phrase",
          paragraph: null,
          paragraph_index: 0,
        },
      },
      expected: [201],
    });
  }

  const articleQuery = "What does observed evidence add?";
  let articleNote = listed.items.find((item) => item.query === articleQuery);
  if (articleNote === undefined) {
    articleNote = await jsonRequest("POST", `/vaults/${primaryVaultId}/sessions`, {
      token: owner.access_token,
      body: {
        idempotency_key: "verification-article-note-v1",
        exchange: {
          id: "ex-verification-article-note",
          query: articleQuery,
          thinking: [],
          answer: "It establishes what a person can actually see, understand, and recover from.",
        },
        origin: {
          doc_path: "wiki/verification-synthesis.md",
          origin_scope: "vault",
          anchor: "what a person can see and recover from",
          paragraph: null,
          paragraph_index: 0,
        },
      },
      expected: [201],
    });
  }

  return {
    main_session_id: main.id,
    personal_reference_note_session_id: referenceNote.id,
    article_note_session_id: articleNote.id,
  };
};

const defaultVault = async (account) => {
  const page = await listVaults(account.access_token);
  return (
    page.items.find((vault) => vault.name === `${account.email}'s vault`) ??
    page.items.find((vault) => vault.owner_id === account.user_id)
  );
};

await mkdir(stateDir, { recursive: true });

const accounts = {};
for (const [role, identity] of Object.entries(identities)) {
  accounts[role] = await signIn(identity.email);
}

for (const account of Object.values(accounts)) {
  const own = await defaultVault(account);
  if (own === undefined) throw new Error(`default vault missing for ${account.email}`);
  account.default_vault_id = own.id;
}

const primary = await ensureVault(
  accounts.owner,
  "Verification Primary",
  "A disposable vault for observing owner behavior, failures, recovery, and cross-scope boundaries.",
);
const alternate = await ensureVault(
  accounts.owner,
  "Verification Alternate",
  "A second disposable vault used only for active-vault and cross-tab checks.",
);

await ensureMembership(accounts.owner, primary.id, accounts.editor, "editor");
await ensureMembership(accounts.owner, primary.id, accounts.viewer, "viewer");

const content = await seedContent(primary.id, accounts.owner.user_id);
const sessions = await ensureSessions(accounts.owner, primary.id);

const manifest = {
  source_commit: sourceCommit,
  generated_at: new Date().toISOString(),
  urls: {
    web: webBase,
    api: apiBase,
    fixtures: fixtureBase,
  },
  providers: {
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    parallel: Boolean(process.env.PARALLEL_API_KEY),
    r2: false,
  },
  accounts,
  vaults: {
    primary: { id: primary.id, name: primary.name },
    alternate: { id: alternate.id, name: alternate.name },
  },
  fixtures: {
    ...content,
    sessions,
    external_urls: {
      article: `${fixtureBase}/article`,
      same_stem_a: `${fixtureBase}/host-a/report`,
      same_stem_b: `${fixtureBase}/host-b/report`,
      redirect: `${fixtureBase}/redirect`,
      slow: `${fixtureBase}/slow?ms=4000`,
      error: `${fixtureBase}/error`,
      empty: `${fixtureBase}/empty`,
      pdf: `${fixtureBase}/document.pdf`,
    },
  },
};

const manifestPath = join(stateDir, "manifest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await chmod(manifestPath, 0o600);

console.log(
  JSON.stringify({
    event: "verification_fixtures_ready",
    manifest: manifestPath,
    primary_vault_id: primary.id,
    accounts: Object.fromEntries(
      Object.entries(accounts).map(([role, account]) => [role, account.email]),
    ),
    providers: manifest.providers,
  }),
);
