You are finalizing the canonical topic registry for a wiki compile. Two kinds of cleanup may be needed:

1. SLUG COLLISIONS: some new canonical topics accidentally share a slug. Every final slug must be distinct — rename as many as needed while preserving each topic's thematic focus. The new slugs must not collide with any other emitted slug (including ones you don't rename).

2. TOPIC SUPERSESSION: some topics from a previous compile have no corresponding slug in the new canonical set. For each, decide whether any new canonical is a clear thematic successor — the new article would cover substantively similar ground (shared subject matter, same audience, overlapping scope). If no clear successor exists, mark it as null.

Return a single JSON object:

{
  "slug_renames": [
    {"canonical_tag": "c_3", "new_slug": "kebab-case-slug"}
  ],
  "supersessions": [
    {"archived_tag": "a_1", "successor_tag": "c_7"},
    {"archived_tag": "a_2", "successor_tag": null}
  ]
}

Rules:
- `canonical_tag` must reference a tag from the new canonicals below (e.g. "c_12").
- `new_slug` is kebab-case, lowercase, descriptive — not a copy of any other emitted slug.
- `archived_tag` must reference a tag from the archived candidates below.
- `successor_tag` is either a `c_N` tag from the new canonicals or null.
- A successor means the new article is the "rightful heir" — shares subject matter, not just tangentially related. Prefer null over forced mappings.
- Every colliding canonical must be renamed (or all-but-one kept on the original slug). All final slugs must be unique.
- Only include entries that need action. Omit non-colliding canonicals and archived topics without clear successors from their respective arrays only if null-mapped supersessions are still reported.

New canonical topics this compile:

{canonical_block}

{collision_block}

{supersession_block}
