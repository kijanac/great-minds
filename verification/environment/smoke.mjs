import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const environmentDir = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(environmentDir, ".state", "manifest.json");
if (!existsSync(manifestPath)) throw new Error("verification manifest is missing");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const api = manifest.urls.api;
const primary = manifest.vaults.primary.id;

const request = async (path, token, expected = 200) => {
  const response = await fetch(`${api}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  let body = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (response.status !== expected) {
    throw new Error(`GET ${path} returned ${response.status}, expected ${expected}`);
  }
  return body;
};

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

for (const [role, expectedRole] of [
  ["owner", "owner"],
  ["editor", "editor"],
  ["viewer", "viewer"],
]) {
  const vault = await request(`/vaults/${primary}`, manifest.accounts[role].access_token);
  expect(vault.role === expectedRole, `${role} resolved as ${vault.role}`);
}
await request(`/vaults/${primary}`, manifest.accounts.nonmember.access_token, 403);

const ownerToken = manifest.accounts.owner.access_token;
const wiki = await request(`/vaults/${primary}/wiki?limit=200&offset=0`, ownerToken);
const sources = await request(`/vaults/${primary}/raw/sources?limit=200&offset=0`, ownerToken);
const references = await request("/me/refs?limit=200&offset=0", ownerToken);
const sessions = await request(`/vaults/${primary}/sessions?limit=200&offset=0`, ownerToken);
const referenceNotes = await request(
  `/vaults/${primary}/sessions/by-origin?doc_path=${encodeURIComponent("refs/verification-reference.md")}`,
  ownerToken,
);
const articleNotes = await request(
  `/vaults/${primary}/sessions/by-origin?doc_path=${encodeURIComponent("wiki/verification-synthesis.md")}`,
  ownerToken,
);
const lint = await request(`/vaults/${primary}/lint`, ownerToken);

expect(wiki.items.length === 2, `expected 2 wiki articles, found ${wiki.items.length}`);
expect(sources.items.length === 3, `expected 3 sources, found ${sources.items.length}`);
expect(references.items.length === 1, `expected 1 reference, found ${references.items.length}`);
expect(
  sessions.items.length === 1,
  `expected 1 main-history session, found ${sessions.items.length}`,
);
expect(
  referenceNotes.length === 1,
  `expected 1 personal-reference note, found ${referenceNotes.length}`,
);
expect(articleNotes.length === 1, `expected 1 article note, found ${articleNotes.length}`);
expect(lint.orphans.length === 0, `expected no orphan articles, found ${lint.orphans.length}`);
expect(
  lint.dirty_topics.length === 0,
  `expected no dirty topics, found ${lint.dirty_topics.length}`,
);
expect(
  lint.unmentioned_links.length === 0,
  `expected no unmentioned links, found ${lint.unmentioned_links.length}`,
);

await request(`/vaults/${primary}/doc?path=wiki/verification-synthesis.md`, ownerToken);
await request(`/vaults/${primary}/doc?path=raw/books/verification-handbook.md`, ownerToken);
await request("/me/refs/doc?path=refs/verification-reference.md", ownerToken);

const web = await fetch(`${manifest.urls.web}/login`, { signal: AbortSignal.timeout(5_000) });
expect(web.ok, `web login returned ${web.status}`);
const fixture = await fetch(`${manifest.urls.fixtures}/article`, {
  signal: AbortSignal.timeout(5_000),
});
expect(fixture.ok, `URL fixture returned ${fixture.status}`);

console.log(
  JSON.stringify({
    event: "verification_environment_smoke_passed",
    source_commit: manifest.source_commit,
    primary_vault_id: primary,
    counts: {
      articles: wiki.items.length,
      sources: sources.items.length,
      references: references.items.length,
      sessions: sessions.items.length + referenceNotes.length + articleNotes.length,
    },
    roles: ["owner", "editor", "viewer", "nonmember"],
  }),
);
