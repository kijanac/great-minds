import { useParams, useLoaderData, Navigate } from "react-router";

import { ArticleReader } from "@/containers/article-reader";
import { docLoader } from "@/pages/doc-loader";

export default function DocPage() {
  const { "*": path } = useParams();
  const data = useLoaderData<typeof docLoader>();

  if (!path) return <Navigate to="/" replace />;

  return (
    <ArticleReader
      path={path}
      document={data?.document ?? null}
      body={data?.body ?? null}
      archived={data?.archived ?? false}
      supersededBy={data?.superseded_by ?? null}
    />
  );
}
