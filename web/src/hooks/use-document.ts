import { useEffect, useState } from "react"

import { readDocument } from "@/api/doc"

export function useDocument(path: string | null) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!path) {
      setContent(null)
      return
    }

    let active = true
    setLoading(true)
    readDocument(path)
      .then((data) => { if (active) setContent(data.content) })
      .catch(() => { if (active) setContent(null) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [path])

  return { content, loading }
}
