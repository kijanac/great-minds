import { useCallback, useRef, useState } from "react"

import { queryKnowledgeBase } from "@/api/query"
import type { BtwThread, SelectionInfo } from "@/lib/types"

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

/**
 * Manages BTW threads for a single document context.
 * Used by both the query thread and the article reader.
 */
export function useBtw() {
  const [btws, setBtws] = useState<BtwThread[]>([])
  const cleanupRef = useRef<(() => void)[]>([])

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
    setBtws((prev) => [...prev, btw])
  }, [])

  const replyBtw = useCallback((btwId: string, userText: string) => {
    setBtws((prev) =>
      prev.map((b) =>
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
    )

    queryKnowledgeBase(userText).then((answer) => {
      const cancel = simulateStream(
        answer,
        (partial) => {
          setBtws((prev) =>
            prev.map((b) =>
              b.id === btwId ? { ...b, streamText: partial } : b,
            ),
          )
        },
        () => {
          setBtws((prev) =>
            prev.map((b) =>
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
          )
        },
      )
      cleanupRef.current.push(cancel)
    })
  }, [])

  const cleanup = useCallback(() => {
    for (const fn of cleanupRef.current) fn()
    cleanupRef.current = []
    setBtws([])
  }, [])

  return { btws, startBtw, replyBtw, cleanup }
}
