import { useCallback, useEffect, useRef, useState } from "react"

import { queryKnowledgeBase } from "@/api/query"
import type { BtwThread, SelectionInfo } from "@/lib/types"
import { assistantMsg, userMsg } from "@/lib/types"
import { genId, simulateStream } from "@/lib/utils"

export function useBtw() {
  const [btws, setBtws] = useState<BtwThread[]>([])
  const cleanupRef = useRef<(() => void)[]>([])

  // Self-contained unmount cleanup — intervals are cleared
  // regardless of what the consumer does
  useEffect(() => {
    return () => {
      for (const fn of cleanupRef.current) fn()
      cleanupRef.current = []
    }
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
    setBtws((prev) => [...prev, btw])
  }, [])

  const replyBtw = useCallback((btwId: string, userText: string) => {
    let anchor = ""
    setBtws((prev) =>
      prev.map((b) => {
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
    )

    const contextualQuery = anchor
      ? `Regarding "${anchor}": ${userText}`
      : userText

    queryKnowledgeBase(contextualQuery).then((answer) => {
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
                      assistantMsg(answer),
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

  const dismissEmpty = useCallback((btwId: string) => {
    setBtws((prev) => {
      const target = prev.find((b) => b.id === btwId)
      if (target && target.messages.length === 0 && !target.streaming) {
        return prev.filter((b) => b.id !== btwId)
      }
      return prev
    })
  }, [])

  const cleanup = useCallback(() => {
    for (const fn of cleanupRef.current) fn()
    cleanupRef.current = []
    setBtws([])
  }, [])

  return { btws, startBtw, replyBtw, dismissEmpty, cleanup }
}
