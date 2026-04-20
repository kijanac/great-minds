import { useParams, useLoaderData, Navigate, type LoaderFunctionArgs } from "react-router";

import { readDocument } from "@/api/doc";
import { ArticleReader } from "@/containers/article-reader";

export async function docLoader({ params, request }: LoaderFunctionArgs) {
  const path = params["*"];
  if (!path) return null;

  try {
    return await readDocument(path, request.signal);
  } catch {
    return null;
  }
}

export default function DocPage() {
  const { "*": path } = useParams();
  const data = useLoaderData<typeof docLoader>();

  if (!path) return <Navigate to="/" replace />;

  return (
    <ArticleReader
      path={path}
      content={data?.content ?? null}
      archived={data?.archived ?? false}
      supersededBy={data?.superseded_by ?? null}
    />
  );
}
