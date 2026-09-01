export const fixtureIds = {
  user: "10000000-0000-4000-8000-000000000001",
  vault: "10000000-0000-4000-8000-000000000101",
  membership: "10000000-0000-4000-8000-000000000201",
  docs: Array.from({ length: 8 }, (_, index) => `10000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`),
  firstRun: "10000000-0000-4000-8002-000000000001",
  secondRun: "10000000-0000-4000-8002-000000000002",
  cancelRun: "10000000-0000-4000-8002-000000000003",
  stagedRun: "10000000-0000-4000-8002-000000000004",
  archiveTopic: "10000000-0000-4000-8003-000000000001",
  archiveNoFileTopic: "10000000-0000-4000-8003-000000000002",
  archiveArticle: "10000000-0000-4000-8004-000000000001",
  secondUser: "10000000-0000-4000-8005-000000000001",
  secondVault: "10000000-0000-4000-8005-000000000002",
  secondMembership: "10000000-0000-4000-8005-000000000003",
} as const;

const subjects = [
  "Mutual aid and neighborhood resilience",
  "Public libraries as civic infrastructure",
  "Worker education and democratic participation",
  "Community archives and collective memory",
  "Food cooperatives and local supply chains",
  "Tenant organizing and housing stability",
  "Open source tools for public institutions",
  "Oral history as a research method",
] as const;

export const corpus = subjects.map((title, index) => ({
  id: fixtureIds.docs[index] as string,
  path: `raw/docs/golden-${index + 1}.md`,
  content: `---\nsource_id: ${fixtureIds.docs[index]}\nsource_type: document\norigin: golden fixture\n---\n# ${title}\n\n${title} depends on durable relationships, shared knowledge, and accountable institutions. This fixture contrasts immediate service delivery with long-term capacity building and records concrete tradeoffs for synthesis. ^p0\n\nA second section connects the case to governance, access, maintenance, and the distribution of decision-making power. It provides overlapping vocabulary across documents while retaining a distinct empirical emphasis. ^p1\n`,
}));
