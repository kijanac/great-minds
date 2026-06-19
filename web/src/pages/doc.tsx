import { useEffect } from "react";
import { useParams, useLoaderData, useLocation, Navigate } from "react-router";

import { ArticleReader } from "@/containers/article-reader";
import { docLoader } from "@/pages/doc-loader";

export default function DocPage() {
  const { "*": path } = useParams();
  const data = useLoaderData<typeof docLoader>();
  const { hash } = useLocation();

  // Deep-link to a paragraph anchor (e.g. #^p47 from a chunk citation): scroll
  // it into view once the body has rendered. react-router doesn't do native
  // hash scrolling, so we do it ourselves; `:target` CSS handles the highlight.
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
  }, [hash, data]);

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
