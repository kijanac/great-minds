# Compile Registry — Probe Findings (2026-06-26)

Empirical measurements against the production vault (`4da93b80-f9be-47e8-bd84-a2519344d3ce`, Render box). Results only, no analysis.

## Vault state
- Active topics: **70** (69 rendered, 1 unrendered). Archived: **471**. All 541 dated 2026-05.
- Active membership: 68,116 rows over 45,397 distinct ideas.
- Ideas per active topic: min 76, median **795**, p90 2,032, max **3,266**, mean 973.
- Topics per idea (active): **63%** in exactly 1, 27% in 2, 10% in 3+, max 9.

## Active-topic separation (pairwise membership Jaccard, 70 active topics)
- 1,324 of 2,415 possible pairs share ≥1 idea.
- Pairs with Jaccard ≥0.1: **5**; ≥0.3: **0**. Max **0.266**; mean among sharing pairs 0.009.

## Archived vs. active
- 515,195 archived membership rows; **100%** of archived idea_ids still exist in `ideas`.
- Every one of the 471 archived topics overlaps ≥1 active topic.
- Best active match by containment (|A∩B|/|A|): ≥0.8: **3**; ≥0.5: 103; <0.3: 173. Mean **0.375**.
- Best active match by Jaccard: ≥0.5: **0**; ≥0.7: **0**. Mean **0.126**.
- Archived idea multi-membership: 55,200 distinct ideas, ~9.3 archived topics per idea.
- The 471 archived map onto 66 of 70 active topics.

## Over-merge chain (latest compile)
- 16 partition chunks → **307 local topics** (12–29 per chunk) → registry emitted **70 canonicals** (≈4.4× merge).
- Registry sizes across 4 recorded compiles: **70, 50, 100, 88**.
- `canonicalize_registry` prompt target: 100–300 articles.

## Two-draw registry stability
Same 307 local topics, compile cache stubbed (always-miss), `thematic_hint=""`, two independent registry+assign draws.
- Article counts: draw 1 = **56**, draw 2 = **90**.
- draw1→draw2 best-Jaccard: ≥0.9: 13/56; ≥0.7: 20; ≥0.5: 37; ≥0.3: 48. Mean 0.600, median 0.550. Containment mean 0.764 (≥0.8: 28).
- draw2→draw1 best-Jaccard: ≥0.9: 13/90; ≥0.7: 20; ≥0.5: 38; ≥0.3: 55. Mean 0.451, median 0.391. Containment mean 0.902 (≥0.8: 72).
- Stable core: 13 topics match ≥0.9, 20 match ≥0.7, in both directions.

_Caveats: two-draw probe is n=2 draws, run with `thematic_hint=""` (prod uses a hint), one transient LLM retry during the run._
