import { useEffect, useState } from "react";

import {
  type Contradiction,
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
        setRecentArticles(articles);
        setContentTypes(sources.content_types);
      })
      .catch(() => {
        setSuggestions([]);
        setContradictions([]);
        setRecentArticles([]);
        setContentTypes([]);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <ExplorePage
      suggestions={suggestions}
      contradictions={contradictions}
      recentArticles={recentArticles}
      contentTypes={contentTypes}
      loading={loading}
      onHome={() => navigate("/")}
      onArticleClick={(path) => navigate(`/doc/${path}`)}
      onExploreWiki={() => navigate("/doc/wiki/_index.md")}
      onExploreSources={(type) =>
        navigate(type ? `/sources?type=${type}` : "/sources")
      }
      ingestionZone={<IngestionContainer />}
    />
  );
}
