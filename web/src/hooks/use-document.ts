import { useEffect, useState } from "react";

import { readDocument } from "@/api/doc";

export function useDocument(path: string | null) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!path) {
      setContent(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    readDocument(path, controller.signal)
      .then((data) => {
        setContent(data.content);
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        setContent(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [path]);

  return { content, loading };
}
