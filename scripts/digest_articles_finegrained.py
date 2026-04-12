"""Fine-grained news digest: incremental event building with per-batch article tagging.

Phase 1 — Incremental event building + tagging (batched)
  Articles are processed in batches of BATCH_SIZE. For each batch the model
  receives the current event landscape plus the new articles and simultaneously:
    • assigns each article to matching existing events, OR
    • creates new events for stories not yet in the landscape.
  After all batches the event landscape is complete and every article is tagged.

Phase 2 — Trend identification
  Sends the final event list to the model and identifies TRENDS: broader
  patterns spanning multiple events. Article→trend membership is derived
  transitively via events.

Output:
  - digest_finegrained.json   full structured result
  - logs/YYYYMMDD_HHMMSS_finegrained.json  per-run prompt log
  - Printed events and trends summary
"""

import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from openai import OpenAI
from tqdm import tqdm

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
MODEL = "deepseek/deepseek-v3.2"

BATCH_SIZE = 10
CACHE_PATH = Path("api_cache.json")

_CACHE: dict[str, str] = {}

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

BATCH_SYSTEM_PROMPT = f"""\
You are incrementally building a news event landscape by processing batches of article summaries.

{EDITORIAL_FOCUS}
You are given:
  1. EXISTING EVENTS — the landscape built so far (may be empty).
  2. NEW ARTICLES — a batch to incorporate.

For each article decide:
  • Match  → assign it to one or more existing events whose story it clearly covers.
  • New    → create a new event if the article covers a story not yet in the landscape.
  • Ignore → mark ignore=true if it is low-value, off-topic, or editorial-focus miss.

Rules for new events:
  - If two articles in this batch cover the same new story, create ONE event, not two.
  - Use a short snake_case id (e.g. "china_tariff_retaliation").
  - New event ids must not collide with any existing event id.

Respond with ONLY valid JSON. Every article id in the input must appear in article_tags.
event_ids in article_tags may reference existing event ids OR new event ids from new_events.
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
# Article loading
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


# ---------------------------------------------------------------------------
# Message builders
# ---------------------------------------------------------------------------

def build_batch_message(articles: list[dict], current_events: list[dict]) -> str:
    lines: list[str] = []

    if current_events:
        lines.append(f"EXISTING EVENTS ({len(current_events)}):")
        for e in current_events:
            lines.append(f'  {e["id"]}: [{e.get("priority", "?").upper()}] {e["title"]}')
    else:
        lines.append("EXISTING EVENTS: (none yet)")

    lines.append(f"\nNEW ARTICLES ({len(articles)}):")
    for a in articles:
        src = f" [{a['source']}]" if a["source"] else ""
        lines.append(f'\n  [{a["id"]}]{src} {a["title"]}')
        if a["summary"]:
            lines.append(f'  {a["summary"][:400]}')

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
# API cache
# ---------------------------------------------------------------------------

def _load_cache() -> None:
    global _CACHE
    if CACHE_PATH.exists():
        _CACHE = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        print(f"Loaded {len(_CACHE)} cached responses from {CACHE_PATH}")


def _write_cache() -> None:
    tmp = CACHE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_CACHE, indent=2), encoding="utf-8")
    tmp.replace(CACHE_PATH)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

def make_client() -> OpenAI:
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
    temperature: float = 0.0,
) -> tuple[str, float]:
    cache_key = hashlib.sha256(f"{model}\n{system}\n{user}".encode()).hexdigest()
    if cache_key in _CACHE:
        log.append({"phase": phase, "model": model, "cached": True, "response": _CACHE[cache_key]})
        return _CACHE[cache_key], 0.0

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
    _CACHE[cache_key] = content
    _write_cache()
    return content, elapsed


def call_batch(
    client: OpenAI, message: str, article_ids: list[int], log: list
) -> tuple[dict, float]:
    phase = f"batch_{article_ids[0]}_{article_ids[-1]}"
    content, elapsed = _chat(client, MODEL, BATCH_SYSTEM_PROMPT, message, log, phase, temperature=0.2)
    return json.loads(content), elapsed


def call_trends(client: OpenAI, message: str, log: list) -> tuple[list[dict], float]:
    content, elapsed = _chat(client, MODEL, TRENDS_SYSTEM_PROMPT, message, log, "trends", temperature=0.2)
    return json.loads(content).get("trends", []), elapsed


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
    print(f"  NEWS DIGEST  ({len(trends)} trends, {len(events)} events from {len(articles)} articles)")
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
    articles_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("articles")
    if not articles_dir.is_dir():
        print(f"Error: '{articles_dir}' is not a directory", file=sys.stderr)
        sys.exit(1)

    _load_cache()
    print(f"Loading articles from {articles_dir.resolve()} …")
    articles = load_articles(articles_dir)
    print(f"Loaded {len(articles)} articles")

    if not articles:
        print("No articles found.")
        sys.exit(0)

    client = make_client()
    run_log: list[dict] = []

    # ------------------------------------------------------------------
    # Phase 1: batch through articles, building events incrementally
    # ------------------------------------------------------------------
    current_events: list[dict] = []        # ordered list passed to each batch
    events_map: dict[str, dict] = {}       # id → event dict with article_ids list
    ignored_ids: list[int] = []

    batches = [articles[i:i + BATCH_SIZE] for i in range(0, len(articles), BATCH_SIZE)]
    print(f"\nPhase 1: {len(articles)} articles in {len(batches)} batches (batch_size={BATCH_SIZE}) …")

    for batch in tqdm(batches):
        batch_ids = [a["id"] for a in batch]
        message = build_batch_message(batch, current_events)
        result, elapsed = call_batch(client, message, batch_ids, run_log)

        # Incorporate new events (skip id collisions silently — treat as match)
        new_events = result.get("new_events", [])
        for ev in new_events:
            eid = ev["id"]
            if eid not in events_map:
                events_map[eid] = {**ev, "articles": []}
                current_events.append(ev)

        # Apply article tags
        article_tags: dict[str, dict] = result.get("article_tags", {})
        n_ignored = 0
        for article in batch:
            tags = article_tags.get(str(article["id"]), {})
            if tags.get("ignore"):
                ignored_ids.append(article["id"])
                n_ignored += 1
            else:
                for eid in tags.get("event_ids", []):
                    if eid in events_map:
                        events_map[eid]["articles"].append({"id": article["id"], "title": article["title"]})

        print(
            f"  [{batch_ids[0]}–{batch_ids[-1]}] "
            f"+{len(new_events)} events, {n_ignored} ignored, "
            f"{len(events_map)} total events ({elapsed:.1f}s)"
        )

    final_events = list(events_map.values())
    # Sort: high → medium → low
    _priority_order = {"high": 0, "medium": 1, "low": 2}
    final_events.sort(key=lambda e: _priority_order.get(e.get("priority", "low"), 2))
    print(f"\nPhase 1 complete: {len(final_events)} events, {len(ignored_ids)} ignored articles")

    # ------------------------------------------------------------------
    # Phase 2: identify trends across final event list
    # ------------------------------------------------------------------
    print(f"\nPhase 2: identifying trends via {MODEL} …")
    trends_message = build_trends_message(final_events)
    trends, elapsed = call_trends(client, trends_message, run_log)

    # Trends carry only event_ids — no article list needed

    print(f"  → {len(trends)} trends ({elapsed:.1f}s)")

    # ------------------------------------------------------------------
    # Save outputs
    # ------------------------------------------------------------------
    out = {
        "events": final_events,
        "trends": trends,
        "ignored_ids": ignored_ids,
    }
    out_path = Path("digest_finegrained.json")
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"\nJSON saved to {out_path.resolve()}")

    logs_dir = Path("logs")
    logs_dir.mkdir(exist_ok=True)
    run_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = logs_dir / f"{run_ts}_finegrained.json"
    log_path.write_text(json.dumps(run_log, indent=2), encoding="utf-8")
    print(f"Run log saved to {log_path.resolve()}")

    print_results(final_events, trends, articles, ignored_ids)


if __name__ == "__main__":
    main()
