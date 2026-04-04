import { useCallback, useEffect, useRef, useState } from "react"

import { queryKnowledgeBase, streamQuery } from "@/api/query"
import type {
  BtwThread,
  Exchange,
  Phase,
  SelectionInfo,
} from "@/lib/types"

let _nextId = 0
function genId(prefix: string) {
  return `${prefix}-${++_nextId}`
}

function simulateStream(
  fullText: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  speed = 4,
  intervalMs = 14,
): () => void {
  let i = 0
  const iv = setInterval(() => {
    i += speed
    onChunk(fullText.slice(0, i))
    if (i >= fullText.length) {
      clearInterval(iv)
      onChunk(fullText)
      onDone()
    }
  }, intervalMs)
  return () => clearInterval(iv)
}

export function useQuerySession() {
  const [phase, setPhase] = useState<Phase>("idle")
  const [thread, setThread] = useState<Exchange[]>([])
  const [liveCards, setLiveCards] = useState<string[]>([])
  const [liveText, setLiveText] = useState("")
  const [chips, setChips] = useState<string[]>([])
  const [popover, setPopover] = useState<SelectionInfo | null>(null)
  const [saved, setSaved] = useState(false)

  const cleanupRef = useRef<(() => void)[]>([])
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      for (const fn of cleanupRef.current) fn()
      abortRef.current?.abort()
    }
  }, [])

  const runExchange = useCallback(async (question: string) => {
    const exId = genId("ex")
    setPhase("searching")
    setLiveCards([])
    setLiveText("")
    setSaved(false)

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const cards: string[] = []
    let answer = ""

    try {
      for await (const event of streamQuery(question, undefined, controller.signal)) {
        if (event.event === "source") {
          const slug =
            event.data.slug ?? event.data.query ?? event.data.path ?? ""
          if (slug) {
            cards.push(slug)
            setLiveCards([...cards])
          }
        } else if (event.event === "token") {
          if (phase !== "streaming") setPhase("streaming")
          answer += event.data.text
          setLiveText(answer)
        } else if (event.event === "done") {
          break
        } else if (event.event === "error") {
          console.error("Stream error:", event.data.message)
          break
        }
      }

      setThread((prev) => [
        ...prev,
        { id: exId, query: question, cards, answer, btws: [] },
      ])
      setLiveCards([])
      setLiveText("")
      setPhase("done")
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
    setPhase("idle")
    setThread([])
    setLiveCards([])
    setLiveText("")
    setChips([])
    setPopover(null)
    setSaved(false)
  }, [])

  const addChip = useCallback((text: string) => {
    setChips((prev) => [...prev, text])
    setPopover(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  const removeChip = useCallback((index: number) => {
    setChips((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // BTW and replies use the non-streaming API + simulated streaming
  // (they're short aside responses, not full traversals)
  const startBtw = useCallback((info: SelectionInfo) => {
    const btwId = genId("btw")
    const btw: BtwThread = {
      id: btwId,
      anchor: info.text,
      paragraphIndex: info.paragraphIndex,
      exchangeId: info.exchangeId,
      messages: [],
      streaming: true,
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

    const btwQuestion = `Brief aside about: "${info.text}"`
    queryKnowledgeBase(btwQuestion).then((answer) => {
      const cancel = simulateStream(
        answer,
        (partial) => {
          setThread((prev) =>
            prev.map((ex) =>
              ex.id === info.exchangeId
                ? {
                    ...ex,
                    btws: ex.btws.map((b) =>
                      b.id === btwId ? { ...b, streamText: partial } : b,
                    ),
                  }
                : ex,
            ),
          )
        },
        () => {
          setThread((prev) =>
            prev.map((ex) =>
              ex.id === info.exchangeId
                ? {
                    ...ex,
                    btws: ex.btws.map((b) =>
                      b.id === btwId
                        ? {
                            ...b,
                            streaming: false,
                            streamText: "",
                            messages: [
                              { role: "assistant" as const, text: answer },
                            ],
                          }
                        : b,
                    ),
                  }
                : ex,
            ),
          )
        },
      )
      cleanupRef.current.push(cancel)
    })
  }, [])

  const replyBtw = useCallback((btwId: string, userText: string) => {
    setThread((prev) =>
      prev.map((ex) => ({
        ...ex,
        btws: ex.btws.map((b) =>
          b.id === btwId
            ? {
                ...b,
                streaming: true,
                streamText: "",
                messages: [
                  ...b.messages,
                  { role: "user" as const, text: userText },
                ],
              }
            : b,
        ),
      })),
    )

    queryKnowledgeBase(userText).then((answer) => {
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
          setThread((prev) =>
            prev.map((ex) => ({
              ...ex,
              btws: ex.btws.map((b) =>
                b.id === btwId
                  ? {
                      ...b,
                      streaming: false,
                      streamText: "",
                      messages: [
                        ...b.messages,
                        { role: "assistant" as const, text: answer },
                      ],
                    }
                  : b,
              ),
            })),
          )
        },
      )
      cleanupRef.current.push(cancel)
    })
  }, [])

  const handleSelection = useCallback((info: SelectionInfo | null) => {
    setPopover(info)
  }, [])

  const clearPopover = useCallback(() => {
    setPopover(null)
  }, [])

  const save = useCallback(() => {
    setSaved(true)
  }, [])

  return {
    phase,
    thread,
    liveCards,
    liveText,
    chips,
    popover,
    saved,
    submitQuery,
    submitFollowUp,
    reset,
    addChip,
    removeChip,
    startBtw,
    replyBtw,
    handleSelection,
    clearPopover,
    save,
  }
}
