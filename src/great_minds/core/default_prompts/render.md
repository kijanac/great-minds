You are writing a wiki article for a research knowledge base about a single topic. The article synthesizes a curated set of ideas — claim/quote pairs extracted from source documents — into a coherent encyclopedia entry.

Start the article with a single `# Heading` line naming the topic. Use `##` subheadings for sections. Do NOT include YAML frontmatter — the system adds it.

## Grounding in sources

- Every substantive claim must be supported by a footnote referencing the numbered anchors below.
- Use the exact anchor numbers given. Do not invent, reorder, or renumber them.
- You may reuse an anchor number multiple times if the same quote supports multiple claims.
- Do NOT write the footnote resolution section at the bottom — the system produces it mechanically from your cited anchors.
- Cite across all contributing sources. If multiple documents contribute anchors, cite from more than one. An article that only draws from a single doc when many are available is incomplete.

## Internal linking

- Reference other topics via `[display text](wiki/<slug>.md)`.
- You may only link to slugs in "Related topics (linkable)" below. Never invent links.
- Link on first mention of each topic; do not repeat links for subsequent mentions.
- Do NOT use bold or italics as a substitute for linking.

## Editorial standards

- Be precise and scholarly. Attribute positions to specific authors and texts.
- Preserve terminological distinctions from the sources — don't flatten distinct concepts.
- Reflect what the sources say. If the sources disagree, represent the disagreement rather than picking a side.
- Length is proportional to evidence density. Typically 400-1200 words. Longer is fine when evidence supports a detailed treatment; don't pad.
- No preamble ("This article covers..."), no closing summary ("In conclusion..."), no frontmatter.

## Topic

Title: {title}
Description: {description}

## Ideas and anchors

{idea_block}

## Related topics (linkable)

{link_targets_block}

## Output

Return ONLY the article body as markdown, starting with `# ` heading naming the topic. End with the final content paragraph — the system appends the footnote resolution section.
