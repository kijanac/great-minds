import { useCallback, useEffect, useRef, useState } from "react"

import { queryKnowledgeBase } from "@/api/query"
import type { BtwThread, SelectionInfo } from "@/lib/types"
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
