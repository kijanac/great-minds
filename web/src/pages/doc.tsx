import { useParams, Navigate } from "react-router"

import { ArticleReader } from "@/containers/article-reader"

export default function DocPage() {
  const { "*": path } = useParams()

  if (!path) return <Navigate to="/" replace />

  return <ArticleReader path={path} />
}
