import { useCallback, useEffect, useRef, useState } from "react"

import { consumeStream, streamQuery } from "@/api/query"
import { appendBtw, appendExchange, createSession } from "@/api/sessions"
import type {
  BtwThread,
  Exchange,
  Phase,
  SelectionInfo,
  ThinkingBlock,
} from "@/lib/types"
import { assistantMsg, userMsg } from "@/lib/types"
import { buildBtwQuery, genId } from "@/lib/utils"

function serializeThread(thread: Exchange[]): string {
  const parts: string[] = []
  for (let i = 0; i < thread.length; i++) {
    const ex = thread[i]
    if (i > 0) parts.push("\n---\n\n")
    parts.push(`# ${ex.query}\n\n`)
    for (const block of ex.thinking) {
      for (const src of block.sources) {
        parts.push(`> \`${src.label}\`\n`)
      }
      parts.push(">\n")
    }
    parts.push(ex.answer + "\n")
    for (const btw of ex.btws) {
      const short = btw.anchor.length > 60 ? btw.anchor.slice(0, 60) + "..." : btw.anchor
      parts.push(`\n> **BTW** re: "${short}"\n>\n`)
      for (const msg of btw.messages) {
        if (msg.role === "user") {
          parts.push(`> *${msg.text}*\n>\n`)
        } else {
          parts.push(`> ${msg.text}\n>\n`)
        }
      }
    }
  }
  return parts.join("").trimEnd() + "\n"
}

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
  originPath?: string
  initialQuery?: string
  onSessionCreated?: (sessionId: string) => void
}

export function useSession(options?: UseSessionOptions) {
  const [phase, setPhase] = useState<Phase>(
    options?.initialExchanges?.length ? "done" : "idle",
  )
  const [thread, setThread] = useState<Exchange[]>(
    options?.initialExchanges ?? [],
  )
  const [sessionId, setSessionId] = useState<string | null>(options?.sessionId ?? null)
  const sessionIdRef = useRef<string | null>(options?.sessionId ?? null)
  const threadRef = useRef(thread)
  threadRef.current = thread
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

  const originPathRef = useRef<string | undefined>(options?.originPath)
  const initialQueryRef = useRef<string | undefined>(options?.initialQuery)
  const onSessionCreatedRef = useRef(options?.onSessionCreated)
  onSessionCreatedRef.current = options?.onSessionCreated
  const isFirstExchange = useRef(true)

  const runExchange = useCallback(async (question: string) => {
    const exId = genId("ex")
    setPhase("searching")
    setLiveThinking([])
    setLiveText("")

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const originForQuery = isFirstExchange.current ? originPathRef.current : undefined
      isFirstExchange.current = false
      const { answer, sources } = await consumeStream(
        streamQuery(question, { signal: controller.signal, originPath: originForQuery, mode: "query" }),
        {
          onSources: (s) => setLiveThinking([{ sources: s }]),
          onToken: (text) => {
            setPhase("streaming")
            setLiveText(text)
          },
        },
      )

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
        createSession(sid, payload, originPathRef.current)
          .then(() => {
            setSessionId(sid)
            onSessionCreatedRef.current?.(sid)
          })
          .catch((e) => console.error("Failed to save session:", e))
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
    setSessionId(null)
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
      paragraph: info.paragraph,
      paragraphIndex: info.paragraphIndex,
      exchangeId: info.exchangeId,
      messages: [],
      sources: [],
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
    const target = threadRef.current.flatMap((ex) => ex.btws).find((b) => b.id === btwId)
    const anchor = target?.anchor ?? ""
    const paragraph = target?.paragraph ?? ""

    const ownerExId = target?.exchangeId ?? ""

    setThread((prev) =>
      prev.map((ex) => {
        if (ex.id !== ownerExId) return ex
        return {
          ...ex,
          btws: ex.btws.map((b) => {
            if (b.id !== btwId) return b
            return {
              ...b,
              streaming: true,
              streamText: "",
              messages: [...b.messages, userMsg(userText)],
            }
          }),
        }
      }),
    )

    const contextualQuery = buildBtwQuery(paragraph, anchor, userText)

    const sessionContext = serializeThread(threadRef.current)
    const controller = new AbortController()
    cleanupRef.current.push(() => controller.abort())

    const updateBtw = (patch: Partial<BtwThread>) =>
      setThread((prev) =>
        prev.map((ex) => {
          if (ex.id !== ownerExId) return ex
          return { ...ex, btws: ex.btws.map((b) => (b.id === btwId ? { ...b, ...patch } : b)) }
        }),
      )

    ;(async () => {
      try {
        const { answer, sources } = await consumeStream(
          streamQuery(contextualQuery, { sessionContext, mode: "btw", signal: controller.signal }),
          {
            onSources: (s) => updateBtw({ sources: s }),
            onToken: (text) => updateBtw({ streamText: text }),
          },
        )

        const finalMessages = [...(target ? target.messages : []), userMsg(userText), assistantMsg(answer)]
        updateBtw({ streaming: false, streamText: "", sources, messages: finalMessages })

        if (sessionIdRef.current) {
          appendBtw(sessionIdRef.current, {
            anchor,
            paragraph,
            exchangeId: ownerExId,
            paragraphIndex: target?.paragraphIndex ?? -1,
            messages: finalMessages,
          }).catch((e) => console.error("Failed to save btw:", e))
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return
      }
    })()
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
    sessionId,
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
