"""Simple news digest: single-prompt event building + trend identification.

Phase 1 — Event building (single prompt)
  All articles are sent to the model at once. The model simultaneously:
    • groups articles into events
    • assigns each article to one or more events
    • ignores low-value / off-topic articles

Phase 2 — Trend identification
  Sends the final event list to the model and identifies TRENDS: broader
  patterns spanning multiple events.

Output:
  - digest_simple.json             full structured result
  - logs/YYYYMMDD_HHMMSS_simple.json  per-run prompt log
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

EVENTS_SYSTEM_PROMPT = f"""\
You are building a news event landscape from a list of article summaries.

{EDITORIAL_FOCUS}
For each article decide:
  • Assign → assign it to one or more events whose story it clearly covers.
  • Ignore → mark ignore=true if it is low-value, off-topic, or editorial-focus miss.

Rules for events:
  - If multiple articles cover the same story, create ONE event for them.
  - Use a short snake_case id (e.g. "china_tariff_retaliation").
  - Every article id in the input must appear in article_tags.

Respond with ONLY valid JSON:
{{
  "events": [
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

def build_events_message(articles: list[dict]) -> str:
    lines = [f"ARTICLES ({len(articles)}):"]
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


def call_events(client: OpenAI, message: str, log: list) -> tuple[dict, float]:
    content, elapsed = _chat(client, MODEL, EVENTS_SYSTEM_PROMPT, message, log, "events", temperature=0.2)
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
    # Phase 1: single prompt — build all events and tag all articles
    # ------------------------------------------------------------------
    print(f"\nPhase 1: building events from {len(articles)} articles in one prompt via {MODEL} …")
    events_message = build_events_message(articles)
    result, elapsed = call_events(client, events_message, run_log)
    print(f"  → done ({elapsed:.1f}s)")

    events_list: list[dict] = result.get("events", [])
    article_tags: dict[str, dict] = result.get("article_tags", {})

    # Build events_map and attach articles
    events_map: dict[str, dict] = {}
    for ev in events_list:
        events_map[ev["id"]] = {**ev, "articles": []}

    ignored_ids: list[int] = []
    for article in articles:
        tags = article_tags.get(str(article["id"]), {})
        if tags.get("ignore"):
            ignored_ids.append(article["id"])
        else:
            for eid in tags.get("event_ids", []):
                if eid in events_map:
                    events_map[eid]["articles"].append({"id": article["id"], "title": article["title"]})

    final_events = list(events_map.values())
    _priority_order = {"high": 0, "medium": 1, "low": 2}
    final_events.sort(key=lambda e: _priority_order.get(e.get("priority", "low"), 2))
    print(f"Phase 1 complete: {len(final_events)} events, {len(ignored_ids)} ignored articles")

    # ------------------------------------------------------------------
    # Phase 2: identify trends across final event list
    # ------------------------------------------------------------------
    print(f"\nPhase 2: identifying trends via {MODEL} …")
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
    }
    out_path = Path("digest_simple.json")
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"\nJSON saved to {out_path.resolve()}")

    logs_dir = Path("logs")
    logs_dir.mkdir(exist_ok=True)
    run_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = logs_dir / f"{run_ts}_simple.json"
    log_path.write_text(json.dumps(run_log, indent=2), encoding="utf-8")
    print(f"Run log saved to {log_path.resolve()}")

    print_results(final_events, trends, articles, ignored_ids)


if __name__ == "__main__":
    main()
