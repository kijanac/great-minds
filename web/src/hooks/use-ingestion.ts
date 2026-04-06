import { useCallback, useEffect, useRef, useState } from "react"

import { ingestUrl, uploadFile } from "@/api/ingest"

export type IngestionStatus = "idle" | "processing" | "done" | "error"

interface IngestionState {
  status: IngestionStatus
  name?: string
  error?: string
}

export function useIngestion() {
  const [state, setState] = useState<IngestionState>({ status: "idle" })
  const [url, setUrl] = useState("")
  const urlRef = useRef(url)
  urlRef.current = url

  useEffect(() => {
    if (state.status !== "done") return
    const t = setTimeout(() => setState({ status: "idle" }), 3000)
    return () => clearTimeout(t)
  }, [state.status])

  const handleIngest = useCallback(
    async (promise: Promise<{ name: string }>) => {
      setState({ status: "processing" })
      try {
        const result = await promise
        setState({ status: "done", name: result.name })
      } catch (e) {
        setState({
          status: "error",
          error: e instanceof Error ? e.message : "Ingestion failed",
        })
      }
    },
    [],
  )

  const handleFileDrop = useCallback(
    (file: File) => {
      setUrl("")
      handleIngest(uploadFile(file))
    },
    [handleIngest],
  )

  const handleUrlSubmit = useCallback(() => {
    const trimmed = urlRef.current.trim()
    if (!trimmed) return
    setUrl("")
    handleIngest(ingestUrl(trimmed))
  }, [handleIngest])

  const handleReset = useCallback(() => {
    setState({ status: "idle" })
    setUrl("")
  }, [])

  return {
    status: state.status,
    resultName: state.name,
    errorMessage: state.error,
    url,
    setUrl,
    handleFileDrop,
    handleUrlSubmit,
    handleReset,
  }
}
