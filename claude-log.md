# Claude Log

## [CL-001] LlamaIndex retrieval baseline — 2026-04-11T00:00:00Z
- Source: live-input-from-human.md (--- READ --- message, 2026-04-11)
- What I did:
  - Added `llama-index-core`, `llama-index-embeddings-openai`, `llama-index-llms-openai`, and `llama-index-readers-file` to `pyproject.toml` dependencies.
  - Wrote `src/retrieval_baseline/llama_index.py` implementing:
    - `index` command: loads all documents from `DOCS_DIR` (default `/data/scratch-fast/bzl/great-minds-datasets`) via `SimpleDirectoryReader`, splits into nodes with `SentenceSplitter`, embeds with OpenAI, builds a `VectorStoreIndex`, and persists it to `INDEX_DIR` (default `DOCS_DIR/.llama_index`).
    - `query` command: loads the persisted index, wraps it in a `query_engine`, and answers questions either from a positional arg or interactively. Supports `--top-k`, `--response-mode`, `--show-sources`, and `--verbose` flags.
    - All paths and model names are overridable via CLI flags or env vars (`LLAMA_DOCS_DIR`, `LLAMA_INDEX_DIR`, `LLAMA_EMBED_MODEL`, `LLAMA_LLM_MODEL`).
- Files changed:
  - `pyproject.toml` (added 4 llama-index deps)
  - `src/retrieval_baseline/llama_index.py` (new file, ~200 lines)
- Job IDs submitted: none
- Result: Code written; documents not yet uploaded so index cannot be tested yet. Run `uv sync` first to install new deps.
- Commit: pending
