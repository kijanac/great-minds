"""Clustering-based news digest using HDBSCAN.

Phase 0 — Embedding
  Each article (title + summary) is embedded. Embedder choices:
    • openai  (default) — text-embedding-3-small, OPENAI_API_KEY required
    • tfidf             — TF-IDF + truncated SVD, no API key needed

Phase 1 — Clustering
  HDBSCAN partitions the embedding space into candidate events.
  Articles labeled -1 (noise) are handled in a follow-up LLM pass.

Phase 2 — LLM Cluster Labeling
  Each cluster is labeled (title, category, priority, summary) by the model
  in batches. No routing decisions — cluster membership is fixed by HDBSCAN.

Phase 3 — Noise Article Routing
  Noise articles are sent to the model with the existing event landscape;
  the model assigns them to events or marks them ignored (same protocol as
  digest_articles_finegrained.py).

Phase 4 — Trend Identification
  Broader patterns across the final event list.

Output:
  - digest_clustering.json
  - logs/YYYYMMDD_HHMMSS_clustering.json
  - Printed events and trends summary

Dependencies (beyond the project's pyproject.toml):
  uv add scikit-learn hdbscan   # or: scikit-learn>=1.3 ships HDBSCAN built-in
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
from openai import OpenAI
from tqdm import tqdm

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
MODEL = "deepseek/deepseek-v3.2"
EMBED_MODEL = "openai/text-embedding-3-small"

NOISE_BATCH_SIZE = 10        # articles per noise-routing LLM call
LABEL_CLUSTER_BATCH = 5      # clusters per labeling LLM call
MAX_ARTICLES_PER_CLUSTER_IN_PROMPT = 8  # truncate long clusters for the label prompt

EMBED_CACHE_INDEX_PATH = Path("embed_cache_index.json")  # hash → row index
EMBED_CACHE_MATRIX_PATH = Path("embed_cache.npy")        # float32 matrix (N, D)
API_CACHE_PATH = Path("api_cache.json")

_EMBED_INDEX: dict[str, int] = {}
_EMBED_MATRIX: np.ndarray = np.zeros((0, 0), dtype=np.float32)
_API_CACHE: dict[str, str] = {}

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

EDITORIAL_FOCUS = """\
EDITORIAL FOCUS — give high priority to:
  - Geopolitics and international relations (wars, diplomacy, sanctions, alliances)
  - Domestic politics (elections, legislation, government action, political movements)
  - Social movements, protests, labor, civil rights, and justice
  - Economics with political or societal consequence (trade wars, inequality, crashes)
  - Science, health, and environment with political or societal consequences
  - Technology with political or societal consequences

Deprioritize and ignore celebrity news, entertainment gossip, and sports unless they have clear political or social significance.
"""

CLUSTER_LABEL_SYSTEM = f"""\
You are labeling pre-clustered groups of news articles. Each cluster was formed by
semantic similarity, so its articles likely cover the same underlying news event.

{EDITORIAL_FOCUS}
For each cluster:
  • Generate a concise snake_case event id (unique across all clusters).
  • Write a short title, pick a category, assign priority, and write a 2-3 sentence summary.
  • If the entire cluster is clearly off-topic or low-value per editorial focus, set ignore=true.

Respond with ONLY valid JSON:
{{
  "clusters": [
    {{
      "cluster_id": <int>,
      "ignore": false,
      "event": {{
        "id": "<snake_case id>",
        "title": "<concise event title>",
        "category": "<foreign_policy | domestic_politics | economy | health | law_justice | science | society | entertainment | conflict>",
        "priority": "high|medium|low",
        "summary": "<2-3 sentence synthesis>"
      }}
    }}
  ]
}}
"""

NOISE_SYSTEM_PROMPT = f"""\
You are processing outlier articles that did not cluster with others.

{EDITORIAL_FOCUS}
You are given:
  1. EXISTING EVENTS — the landscape built so far (may be empty).
  2. NOISE ARTICLES  — unclustered articles to process.

For each article decide:
  • Match  → assign to one or more existing events whose story it covers.
  • New    → create a new singleton event if the article is high-value and covers an uncovered story.
  • Ignore → mark ignore=true if it is low-value or off-topic.

Rules for new events:
  - Use a short snake_case id that does not collide with any existing event id.
  - If two articles in this batch cover the same new story, create ONE event.

Respond with ONLY valid JSON. Every article id in the input must appear in article_tags.
{{
  "new_events": [
    {{
      "id": "<snake_case id>",
      "title": "<concise event title>",
      "category": "<foreign_policy | domestic_politics | economy | health | law_justice | science | society | entertainment | conflict>",
      "priority": "high|medium|low",
      "summary": "<2-3 sentence synthesis>"
    }}
  ],
  "article_tags": {{
    "<article_id>": {{
      "event_ids": ["<event id>", ...],
      "ignore": false
    }}
  }}
}}
"""

TRENDS_SYSTEM_PROMPT = """\
You are an analyst identifying trends across a set of pre-identified news events.

A TREND is a broader pattern, wave, or ongoing situation that spans multiple events
(e.g. "wave of labor strikes", "escalating US-China trade tensions").
Only create a trend when it genuinely ties several events together.
Each trend maps to one or more events. Each event can belong to multiple trends.

Respond with ONLY valid JSON. Schema:
{
  "trends": [
    {
      "id": "<short snake_case id>",
      "title": "<concise trend title>",
      "category": "<foreign_policy | domestic_politics | economy | health | law_justice | science | society | entertainment | conflict>",
      "priority": "high|medium|low",
      "summary": "<2-3 sentence description of the broader pattern>",
      "event_ids": ["<event id>", ...]
    }
  ]
}

Rules:
- Order trends by priority (high first).
- Only use event IDs provided in the input.
"""


# ---------------------------------------------------------------------------
# Article loading (same as digest_articles_finegrained.py)
# ---------------------------------------------------------------------------

def strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = text.replace("&quot;", '"').replace("&#8230;", "…").replace("&nbsp;", " ")
    return re.sub(r"\s+", " ", text).strip()


def extract_frontmatter(text: str) -> dict[str, str]:
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return {}
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            meta[key.strip()] = val.strip().strip('"')
    return meta


def extract_summary(text: str) -> str:
    m = re.search(r"## Summary\s*\n(.*?)(?=\n## |\Z)", text, re.DOTALL)
    if not m:
        return ""
    return strip_html(m.group(1).strip())


def load_articles(articles_dir: Path) -> list[dict]:
    articles = []
    for i, path in enumerate(sorted(articles_dir.glob("*.md")), start=1):
        raw = path.read_text(encoding="utf-8")
        meta = extract_frontmatter(raw)
        title = meta.get("title", path.stem)
        summary = extract_summary(raw)
        if not summary:
            m = re.search(r"## Full Text\s*\n(.+)", raw)
            if m:
                summary = strip_html(m.group(1).strip().split("\n")[0])
        articles.append({
            "id": i,
            "title": title,
            "source": meta.get("source", ""),
            "summary": summary,
            "path": path.name,
        })
    return articles


def article_text(a: dict) -> str:
    """Combined text used for embedding."""
    parts = [a["title"]]
    if a.get("source"):
        parts.append(f"[{a['source']}]")
    if a.get("summary"):
        parts.append(a["summary"][:500])
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Embedding cache
# ---------------------------------------------------------------------------

def _load_embed_cache() -> None:
    global _EMBED_INDEX, _EMBED_MATRIX
    if EMBED_CACHE_INDEX_PATH.exists() and EMBED_CACHE_MATRIX_PATH.exists():
        _EMBED_INDEX = json.loads(EMBED_CACHE_INDEX_PATH.read_text(encoding="utf-8"))
        _EMBED_MATRIX = np.load(str(EMBED_CACHE_MATRIX_PATH))
        print(f"Loaded {len(_EMBED_INDEX)} cached embeddings {_EMBED_MATRIX.shape} from {EMBED_CACHE_MATRIX_PATH}")


def _write_embed_cache() -> None:
    tmp = EMBED_CACHE_INDEX_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_EMBED_INDEX), encoding="utf-8")
    tmp.replace(EMBED_CACHE_INDEX_PATH)
    np.save(str(EMBED_CACHE_MATRIX_PATH), _EMBED_MATRIX)


# ---------------------------------------------------------------------------
# API cache
# ---------------------------------------------------------------------------

def _load_api_cache() -> None:
    global _API_CACHE
    if API_CACHE_PATH.exists():
        _API_CACHE = json.loads(API_CACHE_PATH.read_text(encoding="utf-8"))
        print(f"Loaded {len(_API_CACHE)} cached API responses from {API_CACHE_PATH}")


def _write_api_cache() -> None:
    tmp = API_CACHE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_API_CACHE, indent=2), encoding="utf-8")
    tmp.replace(API_CACHE_PATH)


# ---------------------------------------------------------------------------
# Embedders
# ---------------------------------------------------------------------------

def embed_openai(articles: list[dict], api_key: str) -> np.ndarray:
    """Embed via OpenRouter openai/text-embedding-3-small.

    Cache: embed_cache_index.json (hash → row) + embed_cache.npy (float32 matrix).
    Only articles not already in the index hit the API.
    """
    global _EMBED_INDEX, _EMBED_MATRIX
    client = OpenAI(base_url=OPENROUTER_BASE, api_key=api_key)

    cache_keys = [
        hashlib.sha256(f"{EMBED_MODEL}:{article_text(a)}".encode()).hexdigest()
        for a in articles
    ]
    to_embed: list[tuple[int, str]] = [
        (i, article_text(articles[i]))
        for i, k in enumerate(cache_keys)
        if k not in _EMBED_INDEX
    ]

    if to_embed:
        print(f"  Embedding {len(to_embed)} new articles via OpenRouter {EMBED_MODEL} …")
        new_vecs: list[list[float]] = [None] * len(to_embed)  # type: ignore[list-item]
        EMBED_BATCH = 100
        for chunk_start in range(0, len(to_embed), EMBED_BATCH):
            chunk = to_embed[chunk_start : chunk_start + EMBED_BATCH]
            _, texts = zip(*chunk)
            resp = client.embeddings.create(model=EMBED_MODEL, input=list(texts))
            for j, emb_obj in enumerate(resp.data):
                new_vecs[chunk_start + j] = emb_obj.embedding

        new_array = np.array(new_vecs, dtype=np.float32)
        base_row = _EMBED_MATRIX.shape[0]
        _EMBED_MATRIX = new_array if base_row == 0 else np.vstack([_EMBED_MATRIX, new_array])
        for j, (article_idx, _) in enumerate(to_embed):
            _EMBED_INDEX[cache_keys[article_idx]] = base_row + j
        _write_embed_cache()
    else:
        print(f"  All {len(articles)} embeddings served from cache.")

    rows = [_EMBED_INDEX[k] for k in cache_keys]
    return _EMBED_MATRIX[rows]


def embed_tfidf(articles: list[dict]) -> np.ndarray:
    """Embed using TF-IDF + truncated SVD (no API key needed)."""
    try:
        from sklearn.decomposition import TruncatedSVD
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.preprocessing import normalize
    except ImportError:
        print("scikit-learn is required for tfidf embedder: uv add scikit-learn", file=sys.stderr)
        sys.exit(1)

    texts = [article_text(a) for a in articles]
    vectorizer = TfidfVectorizer(max_features=10_000, ngram_range=(1, 2), sublinear_tf=True)
    X = vectorizer.fit_transform(texts)
    n_components = min(256, X.shape[1] - 1, X.shape[0] - 1)
    svd = TruncatedSVD(n_components=n_components, random_state=42)
    X_reduced = svd.fit_transform(X)
    return normalize(X_reduced).astype(np.float32)


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

def run_hdbscan(
    embeddings: np.ndarray,
    min_cluster_size: int,
    min_samples: int,
) -> np.ndarray:
    """Run HDBSCAN on (normalized) embeddings. Returns integer label array (-1 = noise)."""
    try:
        from sklearn.cluster import HDBSCAN
    except ImportError:
        print(
            "scikit-learn >= 1.3 is required for HDBSCAN: uv add scikit-learn",
            file=sys.stderr,
        )
        sys.exit(1)

    # cosine distance on L2-normalized vectors is equivalent to euclidean / sqrt(2),
    # but cosine is more semantically natural for text embeddings.
    clusterer = HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        metric="cosine",
        cluster_selection_method="eom",  # excess-of-mass: handles variable density well
    )
    return clusterer.fit_predict(embeddings)


# ---------------------------------------------------------------------------
# LLM helpers
# ---------------------------------------------------------------------------

def make_openrouter_client() -> OpenAI:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY environment variable not set")
    return OpenAI(base_url=OPENROUTER_BASE, api_key=api_key)


def _chat(
    client: OpenAI,
    model: str,
    system: str,
    user: str,
    log: list,
    phase: str,
    temperature: float = 0.2,
) -> tuple[str, float]:
    cache_key = hashlib.sha256(f"{model}\n{system}\n{user}".encode()).hexdigest()
    if cache_key in _API_CACHE:
        log.append({"phase": phase, "model": model, "cached": True, "response": _API_CACHE[cache_key]})
        return _API_CACHE[cache_key], 0.0

    t0 = time.perf_counter()
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=temperature,
        response_format={"type": "json_object"},
    )
    elapsed = time.perf_counter() - t0
    content = response.choices[0].message.content or "{}"
    log.append({
        "phase": phase,
        "model": model,
        "system": system,
        "user": user,
        "response": content,
        "elapsed_s": round(elapsed, 2),
    })
    _API_CACHE[cache_key] = content
    _write_api_cache()
    return content, elapsed


# ---------------------------------------------------------------------------
# Message builders
# ---------------------------------------------------------------------------

def build_cluster_label_message(clusters: list[tuple[int, list[dict]]]) -> str:
    """Build labeling prompt for a batch of (cluster_id, articles) pairs."""
    lines = [f"Label the following {len(clusters)} article cluster(s):\n"]
    for cid, arts in clusters:
        shown = arts[:MAX_ARTICLES_PER_CLUSTER_IN_PROMPT]
        omitted = len(arts) - len(shown)
        lines.append(f"CLUSTER {cid} ({len(arts)} articles{f', showing {len(shown)}' if omitted else ''}):")
        for a in shown:
            src = f" [{a['source']}]" if a.get("source") else ""
            lines.append(f"  [{a['id']}]{src} {a['title']}")
            if a.get("summary"):
                lines.append(f"  {a['summary'][:300]}")
        if omitted:
            lines.append(f"  … and {omitted} more articles in this cluster.")
        lines.append("")
    return "\n".join(lines)


def build_noise_message(articles: list[dict], current_events: list[dict]) -> str:
    lines: list[str] = []
    if current_events:
        lines.append(f"EXISTING EVENTS ({len(current_events)}):")
        for e in current_events:
            lines.append(f'  {e["id"]}: [{e.get("priority", "?").upper()}] {e["title"]}')
    else:
        lines.append("EXISTING EVENTS: (none yet)")

    lines.append(f"\nNOISE ARTICLES ({len(articles)}):")
    for a in articles:
        src = f" [{a['source']}]" if a.get("source") else ""
        lines.append(f'\n  [{a["id"]}]{src} {a["title"]}')
        if a.get("summary"):
            lines.append(f"  {a['summary'][:400]}")
    return "\n".join(lines)


def build_trends_message(events: list[dict]) -> str:
    lines = [f"There are {len(events)} events. Identify trends across them.\n"]
    for e in events:
        lines.append(f"({e['id']}) [{e.get('priority', '?').upper()}] {e['title']}")
        if e.get("summary"):
            lines.append(f"  {e['summary']}")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# LLM callers
# ---------------------------------------------------------------------------

def call_label_clusters(
    client: OpenAI,
    clusters: list[tuple[int, list[dict]]],
    log: list,
) -> tuple[list[dict], float]:
    first_id, last_id = clusters[0][0], clusters[-1][0]
    phase = f"label_clusters_{first_id}_{last_id}"
    message = build_cluster_label_message(clusters)
    content, elapsed = _chat(client, MODEL, CLUSTER_LABEL_SYSTEM, message, log, phase)
    try:
        result = json.loads(content)
    except json.JSONDecodeError:
        print(f"  [warn] JSON parse error in cluster label response; skipping batch", file=sys.stderr)
        return [], elapsed
    return result.get("clusters", []), elapsed


def call_noise_batch(
    client: OpenAI,
    message: str,
    article_ids: list[int],
    log: list,
) -> tuple[dict, float]:
    phase = f"noise_{article_ids[0]}_{article_ids[-1]}"
    content, elapsed = _chat(client, MODEL, NOISE_SYSTEM_PROMPT, message, log, phase)
    try:
        result = json.loads(content)
    except json.JSONDecodeError:
        print(f"  [warn] JSON parse error in noise batch; ignoring batch", file=sys.stderr)
        return {"new_events": [], "article_tags": {}}, elapsed
    return result, elapsed


def call_trends(
    client: OpenAI,
    message: str,
    log: list,
) -> tuple[list[dict], float]:
    content, elapsed = _chat(client, MODEL, TRENDS_SYSTEM_PROMPT, message, log, "trends")
    try:
        result = json.loads(content)
    except json.JSONDecodeError:
        return [], elapsed
    return result.get("trends", []), elapsed


# ---------------------------------------------------------------------------
# Visualization
# ---------------------------------------------------------------------------

def save_cluster_viz(
    articles: list[dict],
    embeddings: np.ndarray,
    labels: np.ndarray,
    cluster_to_event: dict[int, str],
    events_map: dict[str, dict],
    out_path: Path,
) -> None:
    """Save an interactive 2D scatter plot of article clusters to an HTML file."""
    try:
        import plotly.graph_objects as go
    except ImportError:
        print("[viz] plotly not installed — skipping. Run: uv add plotly", file=sys.stderr)
        return

    # 2D projection -------------------------------------------------------
    print("  Projecting embeddings to 2D …")
    try:
        import umap as umap_module
        reducer = umap_module.UMAP(n_components=2, random_state=42, metric="cosine")
        coords = reducer.fit_transform(embeddings)
        proj_method = "UMAP"
    except ImportError:
        from sklearn.manifold import TSNE
        perp = min(30, len(articles) - 1)
        reducer_tsne = TSNE(n_components=2, random_state=42, metric="cosine",
                            init="pca", perplexity=perp)
        coords = reducer_tsne.fit_transform(embeddings)
        proj_method = "t-SNE"
    print(f"  Projection method: {proj_method}")

    # Color palette -------------------------------------------------------
    # Use a large qualitative palette; noise (-1) always gray
    PALETTE = [
        "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
        "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
        "#aec7e8", "#ffbb78", "#98df8a", "#ff9896", "#c5b0d5",
        "#c49c94", "#f7b6d2", "#dbdb8d", "#9edae5", "#393b79",
        "#637939", "#8c6d31", "#843c39", "#7b4173", "#5254a3",
    ]
    unique_cluster_ids = sorted(c for c in set(int(lbl) for lbl in labels) if c >= 0)
    cluster_color: dict[int, str] = {
        cid: PALETTE[i % len(PALETTE)] for i, cid in enumerate(unique_cluster_ids)
    }
    cluster_color[-1] = "#cccccc"  # noise = light gray

    # One trace per cluster (enables legend toggle) -----------------------
    traces = []

    def _make_trace(cluster_id: int, cluster_articles: list[dict], cluster_coords: np.ndarray) -> None:
        if cluster_id == -1:
            name = "noise"
        else:
            event_id = cluster_to_event.get(cluster_id, f"cluster_{cluster_id}")
            ev = events_map.get(event_id, {})
            event_title = ev.get("title", event_id)
            priority = ev.get("priority", "")
            name = f"[{priority}] {event_title}" if priority else event_title

        hover_parts = []
        for a in cluster_articles:
            event_id = cluster_to_event.get(cluster_id, "noise" if cluster_id == -1 else f"cluster_{cluster_id}")
            ev = events_map.get(event_id, {})
            lines = [
                f"<b>{a['title']}</b>",
                f"Article ID: {a['id']}",
                f"Source: {a.get('source') or '—'}",
                f"Cluster: {cluster_id}",
                f"Event: {event_id}",
            ]
            if ev.get("title"):
                lines.append(f"Event title: {ev['title']}")
            if ev.get("priority"):
                lines.append(f"Priority: {ev['priority']}")
            hover_parts.append("<br>".join(lines))

        traces.append(go.Scatter(
            x=cluster_coords[:, 0],
            y=cluster_coords[:, 1],
            mode="markers",
            name=name,
            marker=dict(
                color=cluster_color.get(cluster_id, "#888"),
                size=9 if cluster_id != -1 else 6,
                opacity=0.85 if cluster_id != -1 else 0.4,
                line=dict(width=0.5, color="white"),
            ),
            text=hover_parts,
            hovertemplate="%{text}<extra></extra>",
        ))

    # Group articles + coords by cluster label
    from collections import defaultdict
    cluster_article_groups: dict[int, list] = defaultdict(list)
    cluster_coord_groups: dict[int, list] = defaultdict(list)
    for article, label, coord in zip(articles, labels, coords):
        cluster_article_groups[int(label)].append(article)
        cluster_coord_groups[int(label)].append(coord)

    # Add real clusters first (largest first), then noise last
    for cid in sorted(cluster_article_groups.keys(), key=lambda c: (-len(cluster_article_groups[c]) if c != -1 else 1)):
        arts = cluster_article_groups[cid]
        c_coords = np.array(cluster_coord_groups[cid])
        _make_trace(cid, arts, c_coords)

    # Layout --------------------------------------------------------------
    n_clusters = len(unique_cluster_ids)
    fig = go.Figure(data=traces)
    fig.update_layout(
        title=dict(
            text=f"Article Clusters — {proj_method} projection<br>"
                 f"<sup>{n_clusters} clusters · {sum(1 for lbl in labels if lbl == -1)} noise · {len(articles)} total articles</sup>",
            font=dict(size=16),
        ),
        xaxis=dict(title=f"{proj_method} 1", showgrid=False, zeroline=False),
        yaxis=dict(title=f"{proj_method} 2", showgrid=False, zeroline=False),
        legend=dict(
            title="Clusters (click to toggle)",
            font=dict(size=11),
            itemsizing="constant",
        ),
        hoverlabel=dict(bgcolor="white", font_size=12, bordercolor="#ccc"),
        plot_bgcolor="#f8f9fa",
        paper_bgcolor="white",
        width=1200,
        height=800,
    )

    out_path.write_text(fig.to_html(include_plotlyjs="cdn"), encoding="utf-8")
    print(f"  Visualization saved to {out_path.resolve()}")


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def print_results(
    events: list[dict],
    trends: list[dict],
    articles: list[dict],
    ignored_ids: list[int],
) -> None:
    id_to_article = {a["id"]: a for a in articles}
    priority_icon = {"high": "!!!", "medium": "-- ", "low": "   "}

    event_trend_map: dict[str, list[str]] = {}
    for t in trends:
        for eid in t.get("event_ids", []):
            event_trend_map.setdefault(eid, []).append(t["id"])

    print(f"\n{'='*70}")
    print(f"  NEWS DIGEST (clustering)  ({len(trends)} trends, {len(events)} events, {len(articles)} articles)")
    print(f"{'='*70}\n")

    if trends:
        print("TRENDS\n")
        for t in trends:
            icon = priority_icon.get(t.get("priority", "low"), "   ")
            print(f"{icon} [{t.get('priority', '?').upper()}] {t['title']}")
            print(f"    Category : {t.get('category', '')}")
            print(f"    Summary  : {t.get('summary', '')}")
            eids = t.get("event_ids", [])
            if eids:
                print(f"    Events   : {', '.join(eids)}")
            print()

    print("EVENTS\n")
    for e in events:
        icon = priority_icon.get(e.get("priority", "low"), "   ")
        trend_tags = event_trend_map.get(e["id"], [])
        tags_str = f"  [{', '.join(trend_tags)}]" if trend_tags else ""
        print(f"{icon} [{e.get('priority', '?').upper()}] {e['title']}{tags_str}")
        print(f"    Category : {e.get('category', '')}")
        print(f"    Summary  : {e.get('summary', '')}")
        arts = e.get("articles", [])
        if arts:
            print(f"    Articles ({len(arts)}):")
            for a in arts:
                print(f"      [{a['id']}] {a['title']}")
        print()

    if ignored_ids:
        print(f"--- IGNORED ({len(ignored_ids)} articles) ---")
        for aid in ignored_ids:
            a = id_to_article.get(aid)
            if a:
                print(f"  [{aid}] {a['title']}")
        print()

    all_tagged: set[int] = set(ignored_ids)
    for e in events:
        all_tagged.update(a["id"] for a in e.get("articles", []))
    missing = {a["id"] for a in articles} - all_tagged
    if missing:
        print(f"[warn] {len(missing)} articles not accounted for: {sorted(missing)}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Clustering-based news digest using HDBSCAN + LLM labeling"
    )
    parser.add_argument("articles_dir", nargs="?", default="articles",
                        help="Directory of article .md files (default: articles/)")
    parser.add_argument("--embedder", choices=["openai", "tfidf"], default="openai",
                        help="Embedding method (default: openai — requires OPENAI_API_KEY)")
    parser.add_argument("--min-cluster-size", type=int, default=2,
                        help="Minimum articles per HDBSCAN cluster (default: 2)")
    parser.add_argument("--min-samples", type=int, default=1,
                        help="HDBSCAN min_samples — higher = more conservative/more noise (default: 1)")
    parser.add_argument("--visualize", action="store_true",
                        help="Generate an interactive HTML cluster visualization after clustering")
    parser.add_argument("--viz-output", default="cluster_viz.html",
                        help="Output path for the visualization HTML (default: cluster_viz.html)")
    args = parser.parse_args()

    articles_dir = Path(args.articles_dir)
    if not articles_dir.is_dir():
        print(f"Error: '{articles_dir}' is not a directory", file=sys.stderr)
        sys.exit(1)

    _load_embed_cache()
    _load_api_cache()

    print(f"Loading articles from {articles_dir.resolve()} …")
    articles = load_articles(articles_dir)
    print(f"Loaded {len(articles)} articles")

    if not articles:
        print("No articles found.")
        sys.exit(0)

    # ------------------------------------------------------------------
    # Phase 0: Embed
    # ------------------------------------------------------------------
    print(f"\nPhase 0: Embedding via {args.embedder} …")
    if args.embedder == "openai":
        openrouter_key = os.environ.get("OPENROUTER_API_KEY")
        if not openrouter_key:
            print("OPENROUTER_API_KEY not set — falling back to tfidf embedder.", file=sys.stderr)
            embeddings = embed_tfidf(articles)
            actual_embedder = "tfidf"
        else:
            embeddings = embed_openai(articles, openrouter_key)
            actual_embedder = "openai"
    else:
        embeddings = embed_tfidf(articles)
        actual_embedder = "tfidf"
    print(f"  Embedding matrix: {embeddings.shape}")

    # ------------------------------------------------------------------
    # Phase 1: HDBSCAN clustering
    # ------------------------------------------------------------------
    print(
        f"\nPhase 1: HDBSCAN (min_cluster_size={args.min_cluster_size}, "
        f"min_samples={args.min_samples}, metric=cosine) …"
    )
    labels = run_hdbscan(embeddings, args.min_cluster_size, args.min_samples)

    unique_labels = sorted(set(labels))
    n_clusters = sum(1 for l in unique_labels if l >= 0)
    n_noise = int(np.sum(labels == -1))
    print(f"  Result: {n_clusters} clusters, {n_noise} noise articles")

    # Group articles by cluster label
    cluster_map: dict[int, list[dict]] = {}
    noise_articles: list[dict] = []
    for article, label in zip(articles, labels):
        if label == -1:
            noise_articles.append(article)
        else:
            cluster_map.setdefault(int(label), []).append(article)

    # Sort clusters largest-first so the most prominent events are labeled first
    sorted_clusters: list[tuple[int, list[dict]]] = sorted(
        cluster_map.items(), key=lambda x: -len(x[1])
    )

    # Print cluster size histogram
    sizes = [len(v) for v in cluster_map.values()]
    if sizes:
        print(f"  Cluster sizes — min: {min(sizes)}, max: {max(sizes)}, "
              f"mean: {sum(sizes)/len(sizes):.1f}, median: {sorted(sizes)[len(sizes)//2]}")

    # ------------------------------------------------------------------
    # Phase 2: LLM cluster labeling
    # ------------------------------------------------------------------
    client = make_openrouter_client()
    run_log: list[dict] = []

    events_map: dict[str, dict] = {}      # event_id → event dict
    cluster_to_event: dict[int, str] = {} # hdbscan cluster label → event_id
    ignored_ids: list[int] = []
    used_ids: set[str] = set()

    def _unique_id(candidate: str) -> str:
        eid = candidate
        suffix = 2
        while eid in used_ids:
            eid = f"{candidate}_{suffix}"
            suffix += 1
        used_ids.add(eid)
        return eid

    print(f"\nPhase 2: Labeling {n_clusters} clusters via {MODEL} …")
    label_batches = [
        sorted_clusters[i : i + LABEL_CLUSTER_BATCH]
        for i in range(0, len(sorted_clusters), LABEL_CLUSTER_BATCH)
    ]

    for batch in tqdm(label_batches, desc="labeling clusters"):
        labeled, elapsed = call_label_clusters(client, batch, run_log)
        n_new = 0
        for entry in labeled:
            cid = entry.get("cluster_id")
            if entry.get("ignore"):
                for a in cluster_map.get(cid, []):
                    ignored_ids.append(a["id"])
                continue
            ev = entry.get("event")
            if not ev:
                continue
            eid = _unique_id(ev.get("id", f"cluster_{cid}"))
            ev["id"] = eid
            ev["articles"] = [
                {"id": a["id"], "title": a["title"]}
                for a in cluster_map.get(cid, [])
            ]
            events_map[eid] = ev
            if cid is not None:
                cluster_to_event[cid] = eid
            n_new += 1
        print(f"  batch: +{n_new} events ({elapsed:.1f}s)")

    print(f"Phase 2 complete: {len(events_map)} cluster events, {len(ignored_ids)} ignored from clusters")

    # ------------------------------------------------------------------
    # Phase 3: Noise article routing
    # ------------------------------------------------------------------
    if noise_articles:
        print(f"\nPhase 3: Routing {len(noise_articles)} noise articles …")
        current_events = list(events_map.values())
        noise_batches = [
            noise_articles[i : i + NOISE_BATCH_SIZE]
            for i in range(0, len(noise_articles), NOISE_BATCH_SIZE)
        ]

        for noise_batch in tqdm(noise_batches, desc="routing noise"):
            batch_ids = [a["id"] for a in noise_batch]
            message = build_noise_message(noise_batch, current_events)
            result, elapsed = call_noise_batch(client, message, batch_ids, run_log)

            # Incorporate any new singleton events
            for ev in result.get("new_events", []):
                eid = _unique_id(ev.get("id", f"noise_event"))
                ev["id"] = eid
                events_map[eid] = {**ev, "articles": []}
                current_events.append(ev)

            # Apply article tags
            article_tags: dict[str, dict] = result.get("article_tags", {})
            n_ignored_noise = 0
            for article in noise_batch:
                tags = article_tags.get(str(article["id"]), {})
                if tags.get("ignore"):
                    ignored_ids.append(article["id"])
                    n_ignored_noise += 1
                else:
                    for eid in tags.get("event_ids", []):
                        if eid in events_map:
                            events_map[eid]["articles"].append(
                                {"id": article["id"], "title": article["title"]}
                            )

            n_new_singleton = len(result.get("new_events", []))
            print(
                f"  [{batch_ids[0]}–{batch_ids[-1]}] "
                f"+{n_new_singleton} new events, {n_ignored_noise} ignored ({elapsed:.1f}s)"
            )
    else:
        print("\nPhase 3: No noise articles.")

    # Final sorted event list
    _priority_order = {"high": 0, "medium": 1, "low": 2}
    final_events = sorted(
        events_map.values(),
        key=lambda e: _priority_order.get(e.get("priority", "low"), 2),
    )
    print(f"\nTotal: {len(final_events)} events, {len(ignored_ids)} ignored articles")

    # ------------------------------------------------------------------
    # Phase 4: Trend identification
    # ------------------------------------------------------------------
    print(f"\nPhase 4: Identifying trends via {MODEL} …")
    trends_message = build_trends_message(final_events)
    trends, elapsed = call_trends(client, trends_message, run_log)
    print(f"  → {len(trends)} trends ({elapsed:.1f}s)")

    # ------------------------------------------------------------------
    # Save outputs
    # ------------------------------------------------------------------
    out = {
        "events": final_events,
        "trends": trends,
        "ignored_ids": ignored_ids,
        "meta": {
            "embedder": actual_embedder,
            "embed_model": EMBED_MODEL if actual_embedder == "openai" else "tfidf+svd",
            "hdbscan_min_cluster_size": args.min_cluster_size,
            "hdbscan_min_samples": args.min_samples,
            "n_articles": len(articles),
            "n_clusters": n_clusters,
            "n_noise_articles": n_noise,
        },
    }
    out_path = Path("digest_clustering.json")
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"\nJSON saved to {out_path.resolve()}")

    logs_dir = Path("logs")
    logs_dir.mkdir(exist_ok=True)
    run_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = logs_dir / f"{run_ts}_clustering.json"
    log_path.write_text(json.dumps(run_log, indent=2), encoding="utf-8")
    print(f"Run log saved to {log_path.resolve()}")

    print_results(final_events, trends, articles, ignored_ids)

    if args.visualize:
        print("\nGenerating cluster visualization …")
        save_cluster_viz(
            articles=articles,
            embeddings=embeddings,
            labels=labels,
            cluster_to_event=cluster_to_event,
            events_map=events_map,
            out_path=Path(args.viz_output),
        )


if __name__ == "__main__":
    main()
