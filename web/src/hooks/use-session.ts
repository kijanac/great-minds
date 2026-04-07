import { useCallback, useEffect, useRef, useState } from "react"

import { queryKnowledgeBase, streamQuery } from "@/api/query"
import { appendBtw, appendExchange, createSession } from "@/api/sessions"
import type {
  BtwThread,
  Exchange,
  Phase,
  SelectionInfo,
  SourceRef,
  ThinkingBlock,
} from "@/lib/types"
import { assistantMsg, userMsg } from "@/lib/types"
import { genId, simulateStream } from "@/lib/utils"

function exchangeToPayload(ex: Exchange) {
  return {
    id: ex.id,
    query: ex.query,
    thinking: ex.thinking,
    answer: ex.answer,
    btws: ex.btws.map((b) => ({
      anchor: b.anchor,
      messages: b.messages,
    })),
  }
}

interface UseSessionOptions {
  initialExchanges?: Exchange[]
  sessionId?: string
  originSlug?: string
  initialQuery?: string
}

export function useSession(options?: UseSessionOptions) {
  const [phase, setPhase] = useState<Phase>(
    options?.initialExchanges?.length ? "done" : "idle",
  )
  const [thread, setThread] = useState<Exchange[]>(
    options?.initialExchanges ?? [],
  )
  const sessionIdRef = useRef<string | null>(options?.sessionId ?? null)
  const [liveThinking, setLiveThinking] = useState<ThinkingBlock[]>([])
  const [liveText, setLiveText] = useState("")
  const [chips, setChips] = useState<string[]>([])
  const [popover, setPopover] = useState<SelectionInfo | null>(null)

  const cleanupRef = useRef<(() => void)[]>([])
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      for (const fn of cleanupRef.current) fn()
      abortRef.current?.abort()
    }
  }, [])

  const originSlugRef = useRef<string | undefined>(options?.originSlug)
  const initialQueryRef = useRef<string | undefined>(options?.initialQuery)
  const isFirstExchange = useRef(true)

  const runExchange = useCallback(async (question: string) => {
    const exId = genId("ex")
    setPhase("searching")
    setLiveThinking([])
    setLiveText("")

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const sources: SourceRef[] = []
    let answer = ""

    try {
      const originForQuery = isFirstExchange.current ? originSlugRef.current : undefined
      isFirstExchange.current = false
      for await (const event of streamQuery(question, { signal: controller.signal, originSlug: originForQuery })) {
        if (event.event === "token") {
          answer += event.data.text
          setPhase("streaming")
          setLiveText(answer)
        } else if (event.event === "source") {
          const label = event.data.slug ?? event.data.query ?? event.data.path
          const type = event.data.type
          if (label && (type === "article" || type === "raw" || type === "search")) {
            sources.push({ label, type })
            setLiveThinking([{ sources: [...sources] }])
          }
        } else if (event.event === "done") {
          break
        } else if (event.event === "error") {
          console.error("Stream error:", event.data.message)
          break
        }
      }

      const exchange: Exchange = {
        id: exId, query: question, thinking: [{ sources }], answer, btws: [],
      }
      setThread((prev) => [...prev, exchange])
      setLiveThinking([])
      setLiveText("")
      setPhase("done")

      // Auto-persist session
      const payload = exchangeToPayload(exchange)
      if (!sessionIdRef.current) {
        const sid = genId("s")
        sessionIdRef.current = sid
        createSession(sid, payload, originSlugRef.current).catch((e) =>
          console.error("Failed to save session:", e),
        )
      } else {
        appendExchange(sessionIdRef.current, payload).catch((e) =>
          console.error("Failed to append exchange:", e),
        )
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return
      console.error("Query failed:", err)
      setPhase("idle")
    }
  }, [])

  const submitQuery = useCallback(
    (question: string) => {
      if (phase !== "idle" && phase !== "done") return
      runExchange(question)
    },
    [phase, runExchange],
  )

  const submitFollowUp = useCallback(
    (additionalText: string) => {
      const parts = [
        ...chips.map((c) => `re: "${c}"`),
        additionalText,
      ].filter(Boolean)
      const question = parts.join(" — ")
      if (!question.trim()) return
      setChips([])
      runExchange(question)
    },
    [chips, runExchange],
  )

  const reset = useCallback(() => {
    abortRef.current?.abort()
    for (const fn of cleanupRef.current) fn()
    cleanupRef.current = []
    sessionIdRef.current = null
    setPhase("idle")
    setThread([])
    setLiveThinking([])
    setLiveText("")
    setChips([])
    setPopover(null)
  }, [])

  const addChip = useCallback((text: string) => {
    setChips((prev) => [...prev, text])
    setPopover(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  const removeChip = useCallback((index: number) => {
    setChips((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const startBtw = useCallback((info: SelectionInfo) => {
    const btwId = genId("btw")
    const btw: BtwThread = {
      id: btwId,
      anchor: info.text,
      paragraphIndex: info.paragraphIndex,
      exchangeId: info.exchangeId,
      messages: [],
      streaming: false,
      streamText: "",
    }

    setThread((prev) =>
      prev.map((ex) =>
        ex.id === info.exchangeId
          ? { ...ex, btws: [...ex.btws, btw] }
          : ex,
      ),
    )
    setPopover(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  const replyBtw = useCallback((btwId: string, userText: string) => {
    let anchor = ""
    setThread((prev) =>
      prev.map((ex) => ({
        ...ex,
        btws: ex.btws.map((b) => {
          if (b.id !== btwId) return b
          anchor = b.anchor
          return {
            ...b,
            streaming: true,
            streamText: "",
            messages: [
              ...b.messages,
              userMsg(userText),
            ],
          }
        }),
      })),
    )

    const contextualQuery = anchor
      ? `Regarding "${anchor}": ${userText}`
      : userText

    queryKnowledgeBase(contextualQuery).then((answer) => {
      const cancel = simulateStream(
        answer,
        (partial) => {
          setThread((prev) =>
            prev.map((ex) => ({
              ...ex,
              btws: ex.btws.map((b) =>
                b.id === btwId ? { ...b, streamText: partial } : b,
              ),
            })),
          )
        },
        () => {
          // Find the BTW to get its metadata for persistence
          let btwToSave: { anchor: string; exchangeId: string; paragraphIndex: number; messages: { role: "user" | "assistant"; text: string }[] } | null = null

          setThread((prev) =>
            prev.map((ex) => ({
              ...ex,
              btws: ex.btws.map((b) => {
                if (b.id !== btwId) return b
                const finalBtw = {
                  ...b,
                  streaming: false,
                  streamText: "",
                  messages: [
                    ...b.messages,
                    assistantMsg(answer),
                  ],
                }
                btwToSave = {
                  anchor: finalBtw.anchor,
                  exchangeId: finalBtw.exchangeId,
                  paragraphIndex: finalBtw.paragraphIndex,
                  messages: finalBtw.messages,
                }
                return finalBtw
              }),
            })),
          )

          if (btwToSave && sessionIdRef.current) {
            appendBtw(sessionIdRef.current, btwToSave).catch((e) =>
              console.error("Failed to save btw:", e),
            )
          }
        },
      )
      cleanupRef.current.push(cancel)
    })
  }, [])

  const dismissBtw = useCallback((btwId: string) => {
    setThread((prev) =>
      prev.map((ex) => {
        const target = ex.btws.find((b) => b.id === btwId)
        if (!target || target.messages.length > 0 || target.streaming) return ex
        return { ...ex, btws: ex.btws.filter((b) => b.id !== btwId) }
      }),
    )
  }, [])

  const handleSelection = useCallback((info: SelectionInfo | null) => {
    setPopover(info)
  }, [])

  const clearPopover = useCallback(() => {
    setPopover(null)
  }, [])

  // Auto-submit initial query (e.g. from article reader via URL params)
  useEffect(() => {
    if (initialQueryRef.current) {
      runExchange(initialQueryRef.current)
      initialQueryRef.current = undefined
    }
  }, [runExchange])

  return {
    phase,
    thread,
    liveThinking,
    liveText,
    chips,
    popover,
    submitQuery,
    submitFollowUp,
    reset,
    addChip,
    removeChip,
    startBtw,
    replyBtw,
    dismissBtw,
    handleSelection,
    clearPopover,
  }
}
