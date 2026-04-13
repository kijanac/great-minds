You are reconciling wiki article plans from a multi-document knowledge base compilation. Each source document produced its own proposed article plans independently. Your job: cluster semantically equivalent plans into canonical articles so each concept gets ONE article sourced from all contributing documents.

Rules:

- **Merge semantically equivalent plans** even when slugs differ. Examples:
  - `finance-capital` + `imperialism-21st-century` → one article (in Marxist theory, finance-capital IS imperialism's core mechanism)
  - `objective-and-subjective-conditions` + `subjective-objective-conditions` → one article (word order)
  - `proxy-wars` + `proxy-war` → one article (plural/singular)
  - `three-overlapping-crises` + `triple-crises-of-capitalism` → one article (same concept)
  - `revolutionary-process-united-states` + `united-states-revolution` → one article

- **Do NOT merge related-but-distinct concepts.** Examples:
  - `dictatorship-of-the-bourgeoisie` ≠ `dictatorship-of-the-proletariat` (opposites)
  - `party-building` ≠ `party-building-tasks` (general vs. specific action-list)
  - `imperialism` ≠ `anti-imperialism` (critique vs. thing critiqued)

- **Pick a canonical slug per cluster.** Prefer:
  - Lowercase kebab-case (`like-this`, not `LikeThis` or `like_this`)
  - Concise but unambiguous (not `party` alone — too general)
  - Matches existing wiki index slugs when available (prefer "update" over "create" + rename)

- **Merge key_points across the cluster.** Deduplicate semantic duplicates (same point phrased differently → keep one). Preserve genuinely distinct contributions.

- **Merge connections across the cluster.** Union of target slugs, deduplicated.

- **source_indices** is the list of ALL input `source_idx` values that contributed to this cluster, sorted ascending.

- **Action resolution:** if any plan in the cluster has `action="update"`, the canonical action is `"update"` — we're updating an existing article rather than creating new.

- **Every input plan must end up in exactly one output cluster.** Do not drop plans. Do not duplicate.

Input — flat list of raw plans from all source documents:
{plans}

Existing wiki articles (already exist in the knowledge base, for "update" action):
{existing_slugs}

Return a JSON object with:
```
{{
  "articles": [
    {{
      "slug": "canonical-slug",
      "action": "create" | "update",
      "tags": ["tag1", "tag2"],
      "key_points": ["point 1", "point 2"],
      "connections": ["slug-a", "slug-b"],
      "source_indices": [0, 3, 7]
    }}
  ]
}}
```

Respond with ONLY the JSON object, no markdown fencing, no explanation.
