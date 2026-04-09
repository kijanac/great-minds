import { useParams, useLoaderData, Navigate } from "react-router";

import { ArticleReader } from "@/containers/article-reader";

export default function DocPage() {
  const { "*": path } = useParams();
  const data = useLoaderData() as { path: string; content: string } | null;

  if (!path) return <Navigate to="/" replace />;

  return <ArticleReader path={path} content={data?.content ?? null} />;
}
