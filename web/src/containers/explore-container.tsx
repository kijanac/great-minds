import { useEffect, useState } from "react";

import {
  type Orphan,
  type RecentArticle,
  type UnmentionedLink,
  type UnresolvedCitation,
  fetchLintResults,
  fetchRecentArticles,
} from "@/api/explore";
import { type ContentTypeCount, fetchRawSources } from "@/api/sources";
import { ExplorePage } from "@/components/explore-page";
import { IngestionContainer } from "@/containers/ingestion-container";
import { useViewNavigate } from "@/hooks/use-view-navigate";

export function ExploreContainer() {
  const navigate = useViewNavigate();
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [unresolvedCitations, setUnresolvedCitations] = useState<UnresolvedCitation[]>([]);
  const [unmentionedLinks, setUnmentionedLinks] = useState<UnmentionedLink[]>([]);
  const [recentArticles, setRecentArticles] = useState<RecentArticle[]>([]);
  const [contentTypes, setContentTypes] = useState<ContentTypeCount[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchLintResults(),
      fetchRecentArticles(),
      fetchRawSources({ limit: 0 }),
    ])
      .then(([lint, articles, sources]) => {
        setOrphans(lint.orphans);
        setDirtyCount(lint.dirty_topics.length);
        setUnresolvedCitations(lint.unresolved_citations);
        setUnmentionedLinks(lint.unmentioned_links);
        setRecentArticles(articles);
        setContentTypes(sources.content_types);
      })
      .catch(() => {
        setOrphans([]);
        setDirtyCount(0);
        setUnresolvedCitations([]);
        setUnmentionedLinks([]);
        setRecentArticles([]);
        setContentTypes([]);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <ExplorePage
      orphans={orphans}
      dirtyCount={dirtyCount}
      unresolvedCitations={unresolvedCitations}
      unmentionedLinks={unmentionedLinks}
      recentArticles={recentArticles}
      contentTypes={contentTypes}
      loading={loading}
      onHome={() => navigate("/")}
      onArticleClick={(path) => navigate(`/doc/${path}`)}
      onOrphanClick={(slug) => navigate(`/doc/wiki/${slug}.md`)}
      onExploreWiki={() => navigate("/doc/wiki/_index.md")}
      onExploreSources={(type) =>
        navigate(type ? `/sources?type=${type}` : "/sources")
      }
      ingestionZone={<IngestionContainer />}
    />
  );
}
