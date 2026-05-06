import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { getCurrentPipeline, startUrlPipeline } from "@/api/pipelines";
import { PipelinePage } from "@/components/pipeline-page";
import { useActiveVaultId } from "@/hooks/use-vault";
import { usePipelineSSE } from "@/hooks/use-pipeline-sse";

export function PipelineContainer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramsRef = useRef({
    pipelineRunId: searchParams.get("pipeline_run_id"),
    url: searchParams.get("url"),
  });
  const { pipelineRunId: pipelineRunIdParam, url: urlParam } = paramsRef.current;
  const queryClient = useQueryClient();
  const vaultId = useActiveVaultId();

  const [pipelineRunId, setPipelineRunId] = useState<string | null>(pipelineRunIdParam);
  const [noTaskFound, setNoTaskFound] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const { stages, overallDone, overallError, connected } = usePipelineSSE(pipelineRunId);

  useEffect(() => {
    if (pipelineRunIdParam || urlParam) setSearchParams({}, { replace: true });
  }, [pipelineRunIdParam, setSearchParams, urlParam]);

  useEffect(() => {
    if (startedRef.current || pipelineRunId) return;
    startedRef.current = true;

    (async () => {
      try {
        if (urlParam) {
          const run = await startUrlPipeline(urlParam);
          if (vaultId) {
            queryClient.invalidateQueries({ queryKey: ["vault", vaultId, "active-pipeline"] });
          }
          setPipelineRunId(run.id);
          return;
        }

        const current = await getCurrentPipeline();
        if (current) {
          setPipelineRunId(current.id);
        } else {
          setNoTaskFound(true);
        }
      } catch (e) {
        setResolveError(e instanceof Error ? e.message : "Pipeline unavailable");
      }
    })();
  }, [pipelineRunId, queryClient, urlParam, vaultId]);

  return (
    <PipelinePage
      stages={stages}
      overallDone={overallDone}
      overallError={overallError ?? resolveError}
      connected={connected}
      noTaskFound={noTaskFound}
    />
  );
}
