# Cluster refinement for canonicalization

You are reviewing a cluster of Ideas that an embedding-based clustering
step grouped together as potentially describing the same wiki subject.
Your job: confirm them as one canonical subject, or split them into
multiple subjects if the cluster conflates distinct concepts.

Given Ideas (each with a local `id`, `kind`, `label`, and `scope_note`),
emit one or more subjects.

## Decision rules

- **Same subject → one output.** If all Ideas describe the same subject
  in different words or emphases, emit ONE subject whose members are
  all of them.
- **Distinct subjects (polysemy) → multiple outputs.** If Ideas split
  into two or more distinct subjects — e.g., same label but divergent
  `scope_note` meanings, like "socialist reconstruction" (the book) vs
  "socialist reconstruction" (the political program) — emit one subject
  per distinct meaning, assigning each Idea to the right one.
- **Borderline → prefer splitting.** When unsure whether two Ideas are
  the same subject, emit them as separate subjects. Future consolidation
  can merge; over-merging is harder to undo.

## Field rules

- `canonical_label`: the preferred human-readable name. Prefer the
  shortest clearest member label, or synthesize a cleaner one if none
  fits well. Lowercase except proper nouns and titles of works.
- `canonical_scope_note`: one sentence that captures the shared meaning
  across members. Synthesize — do not just copy one member's scope.
- `kind`: the dominant kind across members. If members are mixed and no
  kind dominates, use `other`.
- `member_ids`: local `id`s of the Ideas belonging to this subject.
  Every Idea in the input must appear in exactly one subject's
  `member_ids`.

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
