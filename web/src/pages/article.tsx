import { useParams, Navigate } from "react-router"

import { ArticleReader } from "@/containers/article-reader"

export default function ArticlePage() {
  const { slug } = useParams<{ slug: string }>()

  if (!slug) return <Navigate to="/" replace />

  return <ArticleReader slug={slug} />
}
