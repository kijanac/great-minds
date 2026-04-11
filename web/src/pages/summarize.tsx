import { useEffect, useRef, useState } from "react";

import { getObject, listModels, listObjects, type R2Object, streamSummarize } from "@/api/corpus";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

// Group objects by their top-level prefix (e.g. "corpus/copeland")
function groupByPrefix(objects: R2Object[]): Map<string, R2Object[]> {
  const map = new Map<string, R2Object[]>();
  for (const obj of objects) {
    const parts = obj.key.split("/");
    const group = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    if (!map.has(group)) map.set(group, []);
    map.get(group)!.push(obj);
  }
  return map;
}

export default function SummarizePage() {
  const [objects, setObjects] = useState<R2Object[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loadingObjects, setLoadingObjects] = useState(true);
  const [objectsError, setObjectsError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [docContent, setDocContent] = useState<string | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);

  const [contextPrompt, setContextPrompt] = useState("");
  const [selectedModel, setSelectedModel] = useState("Qwen/Qwen3-8B");

  const [summary, setSummary] = useState("");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<boolean>(false);

  useEffect(() => {
    Promise.all([listObjects(), listModels()])
      .then(([objs, mods]) => {
        setObjects(objs);
        setModels(mods);
      })
      .catch((e) => setObjectsError(String(e)))
      .finally(() => setLoadingObjects(false));
  }, []);

  // Auto-scroll output
  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [summary]);

  function toggleGroup(group: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      next.has(group) ? next.delete(group) : next.add(group);
      return next;
    });
  }

  async function selectDoc(key: string) {
    setSelectedKey(key);
    setDocContent(null);
    setSummary("");
    setRunError(null);
    setLoadingDoc(true);
    try {
      const content = await getObject(key);
      setDocContent(content);
    } catch (e) {
      setDocContent(null);
    } finally {
      setLoadingDoc(false);
    }
  }

  async function runSummarize() {
    if (!selectedKey) return;
    setSummary("");
    setRunError(null);
    setRunning(true);
    abortRef.current = false;

    try {
      for await (const chunk of streamSummarize(selectedKey, contextPrompt, selectedModel)) {
        if (abortRef.current) break;
        setSummary((prev) => prev + chunk);
      }
    } catch (e) {
      setRunError(String(e));
    } finally {
      setRunning(false);
    }
  }

  const filtered = search
    ? objects.filter((o) => o.key.toLowerCase().includes(search.toLowerCase()))
    : objects;

  const groups = groupByPrefix(filtered);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* ── Left panel: document browser ─────────────────────────────── */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Corpus
          </p>
          <input
            className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
            placeholder="Filter documents…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <ScrollArea className="flex-1">
          {loadingObjects && (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          )}
          {objectsError && (
            <p className="p-4 text-sm text-destructive">{objectsError}</p>
          )}
          {!loadingObjects &&
            Array.from(groups.entries()).map(([group, items]) => (
              <div key={group}>
                <button
                  onClick={() => toggleGroup(group)}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted"
                >
                  <span className="text-[10px]">{openGroups.has(group) ? "▼" : "▶"}</span>
                  {group}
                  <span className="ml-auto font-normal normal-case">{items.length}</span>
                </button>
                {openGroups.has(group) &&
                  items.map((obj) => (
                    <button
                      key={obj.key}
                      onClick={() => selectDoc(obj.key)}
                      className={`block w-full truncate px-5 py-1 text-left text-xs hover:bg-muted ${
                        selectedKey === obj.key
                          ? "bg-primary/10 font-medium text-primary"
                          : "text-foreground"
                      }`}
                      title={obj.key}
                    >
                      {obj.key.split("/").pop()}
                    </button>
                  ))}
              </div>
            ))}
        </ScrollArea>
      </div>

      {/* ── Right panel ──────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <span className="truncate text-sm text-muted-foreground">
            {selectedKey ?? "Select a document on the left"}
          </span>
          {loadingDoc && (
            <span className="text-xs text-muted-foreground">loading…</span>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          {/* Context prompt */}
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Context prompt
            </label>
            <textarea
              className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
              rows={4}
              placeholder="e.g. Summarize this document from a socialist perspective, focusing on economic arguments…"
              value={contextPrompt}
              onChange={(e) => setContextPrompt(e.target.value)}
            />
          </div>

          {/* Model selector + run */}
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Model
              </label>
              <select
                className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            {running ? (
              <Button
                variant="outline"
                onClick={() => {
                  abortRef.current = true;
                }}
              >
                Stop
              </Button>
            ) : (
              <Button onClick={runSummarize} disabled={!selectedKey || !docContent}>
                Summarize
              </Button>
            )}
          </div>

          {/* Output */}
          {(summary || runError || running) && (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Summary {running && <span className="animate-pulse">●</span>}
              </label>
              {runError && (
                <p className="mb-2 text-sm text-destructive">{runError}</p>
              )}
              <div
                ref={outputRef}
                className="max-h-[50vh] overflow-y-auto rounded-md border border-border bg-muted p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap"
              >
                {summary || (running ? "Generating…" : "")}
              </div>
            </div>
          )}

          {/* Optional: doc preview */}
          {docContent && !summary && !running && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                Preview document
              </summary>
              <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {docContent.slice(0, 3000)}
                {docContent.length > 3000 && "\n\n[truncated…]"}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
