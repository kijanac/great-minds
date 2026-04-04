import { useEffect, useState } from "react"

import { readArticle } from "@/api/wiki"

export function useArticle(slug: string | null) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!slug) {
      setContent(null)
      return
    }

    setLoading(true)
    readArticle(slug)
      .then((data) => setContent(data.content))
      .catch(() => setContent(null))
      .finally(() => setLoading(false))
  }, [slug])

  return { content, loading }
}
