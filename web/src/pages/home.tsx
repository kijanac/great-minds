import { useState } from "react";
import { useSearchParams } from "react-router";

import { HomeContainer } from "@/containers/home-container";

export default function HomePage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Capture params once on mount, then clear to prevent re-submission on back-nav
  const [{ initialQuery, origin }] = useState(() => {
    const q = searchParams.get("q") ?? undefined;
    const o = searchParams.get("origin") ?? undefined;
    if (q || o) setSearchParams({}, { replace: true });
    return { initialQuery: q, origin: o };
  });

  return <HomeContainer initialQuery={initialQuery} origin={origin} />;
}
