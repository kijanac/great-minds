import { useCallback, useEffect, useRef, useState } from "react";

import { compile, ingestUrl, uploadFile } from "@/api/ingest";
import type { DroppedFile } from "@/lib/types";

export type ItemStatus = "queued" | "processing" | "done" | "error";

export interface QueueItem {
  id: string;
  name: string;
  status: ItemStatus;
  error?: string;
}

export interface QueueSummary {
  total: number;
  done: number;
  failed: number;
  processing: boolean;
}

let nextId = 0;

export function useIngestion() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [url, setUrl] = useState("");
  const urlRef = useRef(url);
  const processingRef = useRef(false);
  const processedCountRef = useRef(0);
  const factoriesRef = useRef<Map<string, () => Promise<{ title: string }>>>(new Map());
  urlRef.current = url;

  // Process next queued item
  useEffect(() => {
    if (processingRef.current) return;

    const next = queue.find((i) => i.status === "queued");
    if (!next) {
      if (processedCountRef.current > 0) {
        processedCountRef.current = 0;
        compile();
      }
      return;
    }

    const factory = factoriesRef.current.get(next.id);
    if (!factory) return;

    processingRef.current = true;
    setQueue((q) => q.map((i) => (i.id === next.id ? { ...i, status: "processing" as const } : i)));

    factory()
      .then((result) => {
        processedCountRef.current++;
        setQueue((q) =>
          q.map((i) => (i.id === next.id ? { ...i, status: "done" as const, name: result.title } : i)),
        );
      })
      .catch((e) => {
        processedCountRef.current++;
        setQueue((q) =>
          q.map((i) =>
            i.id === next.id
              ? {
                  ...i,
                  status: "error" as const,
                  error: e instanceof Error ? e.message : "Ingestion failed",
                }
              : i,
          ),
        );
      })
      .finally(() => {
        factoriesRef.current.delete(next.id);
        processingRef.current = false;
        setQueue((q) => [...q]);
      });
  }, [queue]);

  // Clear entire queue once everything is done (no queued/processing items)
  useEffect(() => {
    if (queue.length === 0) return;
    const hasActive = queue.some((i) => i.status === "queued" || i.status === "processing");
    if (hasActive) return;
    const hasErrors = queue.some((i) => i.status === "error");
    if (hasErrors) return;

    const t = setTimeout(() => setQueue([]), 3000);
    return () => clearTimeout(t);
  }, [queue]);

  const summary: QueueSummary = {
    total: queue.length,
    done: queue.filter((i) => i.status === "done").length,
    failed: queue.filter((i) => i.status === "error").length,
    processing: queue.some((i) => i.status === "queued" || i.status === "processing"),
  };

  const enqueue = useCallback(
    (name: string, factory: () => Promise<{ title: string }>) => {
      const id = `ingest-${nextId++}`;
      factoriesRef.current.set(id, factory);
      setQueue((q) => [...q, { id, name, status: "queued" }]);
    },
    [],
  );

  const handleFileDrop = useCallback(
    (files: DroppedFile[]) => {
      setUrl("");
      for (const { file, path } of files) {
        enqueue(path, () => uploadFile(file, path));
      }
    },
    [enqueue],
  );

  const handleUrlSubmit = useCallback(() => {
    const trimmed = urlRef.current.trim();
    if (!trimmed) return;
    setUrl("");
    enqueue(trimmed, () => ingestUrl(trimmed));
  }, [enqueue]);

  const dismissItem = useCallback((id: string) => {
    factoriesRef.current.delete(id);
    setQueue((q) => q.filter((i) => i.id !== id));
  }, []);

  return {
    queue,
    summary,
    url,
    setUrl,
    handleFileDrop,
    handleUrlSubmit,
    dismissItem,
  };
}
