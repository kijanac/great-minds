import { useParams, useNavigate } from "react-router"

import { useArticle } from "@/hooks/use-article"
import { ArticleReader } from "@/containers/article-reader"

export default function ArticlePage() {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()

  if (!slug) {
    navigate("/")
    return null
  }

  const { content, loading } = useArticle(slug)

  return <ArticleReader slug={slug} content={content} loading={loading} />
}
