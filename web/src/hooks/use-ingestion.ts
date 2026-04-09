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

let nextId = 0;

export function useIngestion() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [url, setUrl] = useState("");
  const urlRef = useRef(url);
  const processingRef = useRef(false);
  const processedCountRef = useRef(0);
  const factoriesRef = useRef<Map<string, () => Promise<{ name: string }>>>(new Map());
  urlRef.current = url;

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
          q.map((i) => (i.id === next.id ? { ...i, status: "done" as const, name: result.name } : i)),
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
        setQueue((q) => [...q]); // trigger re-render to process next
      });
  }, [queue]);

  // Auto-dismiss done items after 3s
  useEffect(() => {
    const doneItems = queue.filter((i) => i.status === "done");
    if (doneItems.length === 0) return;
    const doneIds = new Set(doneItems.map((i) => i.id));
    const t = setTimeout(() => {
      setQueue((q) => q.filter((i) => !doneIds.has(i.id)));
    }, 3000);
    return () => clearTimeout(t);
  }, [queue]);

  const enqueue = useCallback(
    (name: string, factory: () => Promise<{ name: string }>) => {
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
    url,
    setUrl,
    handleFileDrop,
    handleUrlSubmit,
    dismissItem,
  };
}
