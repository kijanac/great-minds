import { useCallback, useEffect, useRef, useState } from "react"

import { ingestUrl, uploadFile } from "@/api/ingest"

export type ItemStatus = "queued" | "processing" | "done" | "error"

export interface QueueItem {
  id: string
  name: string
  status: ItemStatus
  error?: string
}

let nextId = 0

export function useIngestion() {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [url, setUrl] = useState("")
  const urlRef = useRef(url)
  const processingRef = useRef(false)
  const promisesRef = useRef<Map<string, Promise<{ name: string }>>>(new Map())
  const queueRef = useRef(queue)
  urlRef.current = url
  queueRef.current = queue

  const processNext = useCallback(async () => {
    if (processingRef.current) return

    const next = queueRef.current.find((i) => i.status === "queued")
    if (!next) return

    const promise = promisesRef.current.get(next.id)
    if (!promise) return

    processingRef.current = true
    setQueue((q) =>
      q.map((i) =>
        i.id === next.id ? { ...i, status: "processing" as const } : i,
      ),
    )

    try {
      const result = await promise
      setQueue((q) =>
        q.map((i) =>
          i.id === next.id ? { ...i, status: "done" as const, name: result.name } : i,
        ),
      )
    } catch (e) {
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
      )
    } finally {
      promisesRef.current.delete(next.id)
      processingRef.current = false
      processNext()
    }
  }, [])

  // Auto-dismiss done items after 3s
  useEffect(() => {
    const doneItems = queue.filter((i) => i.status === "done")
    if (doneItems.length === 0) return
    const doneIds = new Set(doneItems.map((i) => i.id))
    const t = setTimeout(() => {
      setQueue((q) => q.filter((i) => !doneIds.has(i.id)))
    }, 3000)
    return () => clearTimeout(t)
  }, [queue])

  const enqueue = useCallback(
    (name: string, promise: Promise<{ name: string }>) => {
      const id = `ingest-${nextId++}`
      promisesRef.current.set(id, promise)
      setQueue((q) => [...q, { id, name, status: "queued" }])
      processNext()
    },
    [processNext],
  )

  const handleFileDrop = useCallback(
    (file: File) => {
      setUrl("")
      enqueue(file.name, uploadFile(file))
    },
    [enqueue],
  )

  const handleUrlSubmit = useCallback(() => {
    const trimmed = urlRef.current.trim()
    if (!trimmed) return
    setUrl("")
    enqueue(trimmed, ingestUrl(trimmed))
  }, [enqueue])

  const dismissItem = useCallback((id: string) => {
    promisesRef.current.delete(id)
    setQueue((q) => q.filter((i) => i.id !== id))
  }, [])

  return {
    queue,
    url,
    setUrl,
    handleFileDrop,
    handleUrlSubmit,
    dismissItem,
  }
}
