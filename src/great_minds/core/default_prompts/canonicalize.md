# Cluster refinement for canonicalization

You are reviewing a cluster of Ideas that an embedding-based clustering
step grouped together as potentially describing the same wiki subject.
Your job: confirm them as ONE canonical subject, or split them into
multiple subjects if the cluster genuinely conflates distinct concepts.

Each subject you emit will become a wiki article. Aim for rich,
multi-faceted articles. Ideas merged together contribute their distinct
emphases to a richer canonical scope.

Given Ideas (each with a local `id`, `kind`, `label`, and `scope_note`),
emit one or more subjects.

## Decision rules

- **Same subject → one output.** If all Ideas describe the same
  subject in different words or emphases, emit ONE subject whose
  members are all of them.

- **Default: merge.** Ideas that share a general topic — even when
  scope_notes emphasize different angles, time periods, geographic
  contexts, or aspects of that topic — should merge into ONE canonical
  subject. Their distinct emphases become the richness of the
  canonical scope_note, not grounds for separation.

- **When in doubt, merge.** A rich multi-facet article is more
  valuable than two thin articles with overlapping scope. Over-
  splitting is harder to undo because it fragments the evidence across
  multiple thin records.

## Field rules

- `canonical_label`: the preferred human-readable name for the merged
  subject. Prefer the shortest clearest member label, or synthesize a
  cleaner one that captures the whole. Lowercase except proper nouns
  and titles of works.

- `canonical_scope_note`: one sentence capturing the full subject
  across all member Ideas' angles. Synthesize richly — don't flatten
  to just the intersection. A good scope_note reflects the union of
  what members contribute.

- `kind`: the dominant kind across members. If members are genuinely
  mixed (e.g., some treat something as a `movement` and others as a
  `concept`), pick the broader framing that best represents the
  canonical meaning. Use `other` only when truly mixed and no kind
  dominates.

- `member_ids`: local `id`s of the Ideas in this subject. Every Idea
  in the input must appear in exactly one subject's `member_ids`.

## Output

Return ONLY a JSON object — no markdown fencing, no preamble:

{
  "subjects": [
    {
      "canonical_label": "...",
      "kind": "concept",
      "canonical_scope_note": "...",
      "member_ids": ["i1", "i2"]
    }
  ]
}
