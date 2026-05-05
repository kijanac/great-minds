import { useCallback, useEffect, useRef, useState } from "react";

import { ingestBulk, ingestUrl } from "@/api/ingest";
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

function makeId(): string {
  return `ingest-${nextId++}`;
}

export function useIngestion() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [compileIntentIds, setCompileIntentIds] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const urlRef = useRef(url);
  urlRef.current = url;

  const dismissCompileIntent = useCallback((intentId: string) => {
    setCompileIntentIds((ids) => ids.filter((id) => id !== intentId));
  }, []);

  const batchInFlightRef = useRef(false);
  const filesById = useRef<Map<string, File>>(new Map());
  const urlsById = useRef<Map<string, string>>(new Map());

  const flushFileBatch = useCallback(async () => {
    if (batchInFlightRef.current) return;
    const batch = Array.from(filesById.current.entries());
    if (batch.length === 0) return;

    batchInFlightRef.current = true;
    const queuedFileIds = batch.map(([id]) => id);
    const files = batch.map(([, file]) => file);

    setQueue((q) =>
      q.map((i) => (queuedFileIds.includes(i.id) ? { ...i, status: "processing" as const } : i)),
    );

    try {
      for await (const event of ingestBulk(files)) {
        if (event.phase === "error") {
          const failedNames = new Set((event.failed_uploads ?? []).map((f) => f.name));
          const errMsgByName = new Map((event.failed_uploads ?? []).map((f) => [f.name, f.error]));
          setQueue((q) =>
            q.map((i) => {
              if (!queuedFileIds.includes(i.id)) return i;
              const file = batch.find(([id]) => id === i.id)?.[1];
              const name = file?.name ?? "";
              if (failedNames.has(name)) {
                return {
                  ...i,
                  status: "error",
                  error: errMsgByName.get(name) ?? "Upload failed",
                };
              }
              return { ...i, status: "error", error: event.error ?? "Ingest failed" };
            }),
          );
          break;
        }
        if (event.phase === "done") {
          const failedNames = new Set((event.failed_uploads ?? []).map((f) => f.name));
          const errMsgByName = new Map((event.failed_uploads ?? []).map((f) => [f.name, f.error]));
          setQueue((q) =>
            q.map((i) => {
              if (!queuedFileIds.includes(i.id)) return i;
              const file = batch.find(([id]) => id === i.id)?.[1];
              const name = file?.name ?? "";
              return failedNames.has(name)
                ? {
                    ...i,
                    status: "error",
                    error: errMsgByName.get(name) ?? "Upload failed",
                  }
                : { ...i, status: "done" };
            }),
          );
        }
      }
      queuedFileIds.forEach((id) => filesById.current.delete(id));
    } catch (e) {
      const message = e instanceof Error ? e.message : "Bulk ingest failed";
      setQueue((q) =>
        q.map((i) =>
          queuedFileIds.includes(i.id) && i.status === "processing"
            ? { ...i, status: "error" as const, error: message }
            : i,
        ),
      );
      queuedFileIds.forEach((id) => filesById.current.delete(id));
    } finally {
      batchInFlightRef.current = false;
    }

    if (filesById.current.size > 0) {
      flushFileBatch();
    }
  }, []);

  const processNextUrl = useCallback(async () => {
    const entry = firstQueuedUrl(urlsById.current);
    if (!entry) return;
    const { id, urlValue } = entry;

    setQueue((q) => q.map((i) => (i.id === id ? { ...i, status: "processing" as const } : i)));

    try {
      const result = await ingestUrl(urlValue);
      setQueue((q) =>
        q.map((i) => (i.id === id ? { ...i, status: "done" as const, name: result.title } : i)),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "URL ingest failed";
      setQueue((q) =>
        q.map((i) => (i.id === id ? { ...i, status: "error" as const, error: message } : i)),
      );
    } finally {
      urlsById.current.delete(id);
      if (urlsById.current.size > 0) processNextUrl();
    }
  }, []);

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

  const handleFileDrop = useCallback(
    (files: DroppedFile[]) => {
      setUrl("");
      const newItems: QueueItem[] = [];
      for (const { file, path } of files) {
        const id = makeId();
        filesById.current.set(id, file);
        newItems.push({ id, name: path, status: "queued" });
      }
      setQueue((q) => [...q, ...newItems]);
      flushFileBatch();
    },
    [flushFileBatch],
  );

  const handleUrlSubmit = useCallback(() => {
    const trimmed = urlRef.current.trim();
    if (!trimmed) return;
    setUrl("");
    const id = makeId();
    urlsById.current.set(id, trimmed);
    setQueue((q) => [...q, { id, name: trimmed, status: "queued" }]);
    processNextUrl();
  }, [processNextUrl]);

  const dismissItem = useCallback((id: string) => {
    filesById.current.delete(id);
    urlsById.current.delete(id);
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
    compileIntentIds,
    dismissCompileIntent,
  };
}

function firstQueuedUrl(urlsById: Map<string, string>): { id: string; urlValue: string } | null {
  for (const [id, urlValue] of urlsById) {
    return { id, urlValue };
  }
  return null;
}
