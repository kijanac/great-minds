import { useEffect, useState } from "react";

import {
  type Contradiction,
  type RecentArticle,
  type ResearchSuggestion,
  fetchLintResults,
  fetchRecentArticles,
} from "@/api/explore";
import { ExplorePage } from "@/components/explore-page";
import { IngestionContainer } from "@/containers/ingestion-container";
import { useViewNavigate } from "@/hooks/use-view-navigate";

export function ExploreContainer() {
  const navigate = useViewNavigate();
  const [suggestions, setSuggestions] = useState<ResearchSuggestion[]>([]);
  const [contradictions, setContradictions] = useState<Contradiction[]>([]);
  const [recentArticles, setRecentArticles] = useState<RecentArticle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchLintResults(), fetchRecentArticles()])
      .then(([lint, articles]) => {
        setSuggestions(lint.research_suggestions);
        setContradictions(lint.contradictions);
        setRecentArticles(articles);
      })
      .catch(() => {
        setSuggestions([]);
        setContradictions([]);
        setRecentArticles([]);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <ExplorePage
      suggestions={suggestions}
      contradictions={contradictions}
      recentArticles={recentArticles}
      loading={loading}
      onHome={() => navigate("/")}
      onArticleClick={(path) => navigate(`/doc/${path}`)}
      onExploreWiki={() => navigate("/doc/wiki/_index.md")}
      ingestionZone={<IngestionContainer />}
    />
  );
}
