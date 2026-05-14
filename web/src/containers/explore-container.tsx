import { useEffect, useState } from "react";

import {
  type WikiArticleOverview,
  type UnmentionedLink,
  type UnresolvedCitation,
  fetchLintResults,
  fetchRecentArticles,
} from "@/api/explore";
import { type SourceTypeFacet, fetchSourceDocuments } from "@/api/sources";
import { ExplorePage } from "@/components/explore-page";
import { useViewNavigate } from "@/hooks/use-view-navigate";

export function ExploreContainer() {
  const navigate = useViewNavigate();
  const [orphans, setOrphans] = useState<WikiArticleOverview[]>([]);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [unresolvedCitations, setUnresolvedCitations] = useState<UnresolvedCitation[]>([]);
  const [unmentionedLinks, setUnmentionedLinks] = useState<UnmentionedLink[]>([]);
  const [recentArticles, setRecentArticles] = useState<WikiArticleOverview[]>([]);
  const [sourceTypes, setSourceTypes] = useState<SourceTypeFacet[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchLintResults(), fetchRecentArticles(), fetchSourceDocuments({ limit: 0 })])
      .then(([lint, articles, sources]) => {
        setOrphans(lint.orphans);
        setDirtyCount(lint.dirty_topics.length);
        setUnresolvedCitations(lint.unresolved_citations);
        setUnmentionedLinks(lint.unmentioned_links);
        setRecentArticles(articles);
        setSourceTypes(sources.facets.source_types ?? []);
      })
      .catch(() => {
        setOrphans([]);
        setDirtyCount(0);
        setUnresolvedCitations([]);
        setUnmentionedLinks([]);
        setRecentArticles([]);
        setSourceTypes([]);
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
      sourceTypes={sourceTypes}
      loading={loading}
      onHome={() => navigate("/")}
      onArticleClick={(path) => navigate(`/doc/${path}`)}
      onOrphanClick={(slug) => navigate(`/doc/wiki/${slug}.md`)}
      onExploreWiki={() => navigate("/wiki")}
      onExploreSources={(type) => navigate(type ? `/sources?type=${type}` : "/sources")}
      ingestionZone={null}
    />
  );
}
