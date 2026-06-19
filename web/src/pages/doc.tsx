import { useParams, useLoaderData, Navigate } from "react-router";

import { ArticleReader } from "@/containers/article-reader";
import { useScrollToHash } from "@/hooks/use-scroll-to-hash";
import { docLoader } from "@/pages/doc-loader";

export default function DocPage() {
  const { "*": path } = useParams();
  const data = useLoaderData<typeof docLoader>();

  // Scroll a chunk-citation deep-link (#^p47) into view once the doc renders.
  useScrollToHash(data);

  if (!path) return <Navigate to="/" replace />;

  return (
    <ArticleReader
      path={path}
      document={data?.article ?? null}
      body={data?.body ?? null}
      archived={data?.archived ?? false}
      supersededBy={data?.superseded_by ?? null}
    />
  );
}
