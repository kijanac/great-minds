import { useEffect, useState } from "react";

import {
  type Contradiction,
  type Orphan,
  type RecentArticle,
  type ResearchSuggestion,
  fetchLintResults,
  fetchRecentArticles,
} from "@/api/explore";
import { type ContentTypeCount, fetchRawSources } from "@/api/sources";
import { ExplorePage } from "@/components/explore-page";
import { IngestionContainer } from "@/containers/ingestion-container";
import { useViewNavigate } from "@/hooks/use-view-navigate";

export function ExploreContainer() {
  const navigate = useViewNavigate();
  const [suggestions, setSuggestions] = useState<ResearchSuggestion[]>([]);
  const [contradictions, setContradictions] = useState<Contradiction[]>([]);
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [dirtyCount, setDirtyCount] = useState(0);
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
        setSuggestions(lint.research_suggestions);
        setContradictions(lint.contradictions);
        setOrphans(lint.orphans);
        setDirtyCount(lint.dirty_concepts.length);
        setRecentArticles(articles);
        setContentTypes(sources.content_types);
      })
      .catch(() => {
        setSuggestions([]);
        setContradictions([]);
        setOrphans([]);
        setDirtyCount(0);
        setRecentArticles([]);
        setContentTypes([]);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <ExplorePage
      suggestions={suggestions}
      contradictions={contradictions}
      orphans={orphans}
      dirtyCount={dirtyCount}
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
