import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { listJobs, startUrlJob } from "@/api/jobs";
import { PipelinePage } from "@/components/pipeline-page";
import { useActiveVaultId } from "@/hooks/use-vault";
import { useJobSSE } from "@/hooks/use-job-sse";

export function PipelineContainer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramsRef = useRef({
    jobId: searchParams.get("job_id"),
    url: searchParams.get("url"),
  });
  const { jobId: jobIdParam, url: urlParam } = paramsRef.current;
  const queryClient = useQueryClient();
  const vaultId = useActiveVaultId();

  const [jobId, setJobId] = useState<string | null>(jobIdParam);
  const [noJobFound, setNoJobFound] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const { stages, overallDone, overallError, connected } = useJobSSE(jobId);

  useEffect(() => {
    if (jobIdParam || urlParam) setSearchParams({}, { replace: true });
  }, [jobIdParam, setSearchParams, urlParam]);

  useEffect(() => {
    if (startedRef.current || jobId) return;
    startedRef.current = true;

    (async () => {
      try {
        if (urlParam) {
          const run = await startUrlJob(urlParam);
          if (vaultId) {
            queryClient.invalidateQueries({ queryKey: ["vault", vaultId, "active-job"] });
          }
          setJobId(run.id);
          return;
        }

        const activeJobs = await listJobs("active");
        if (activeJobs.items.length === 1) {
          setJobId(activeJobs.items[0].id);
        } else {
          setNoJobFound(true);
        }
      } catch (e) {
        setResolveError(e instanceof Error ? e.message : "Job unavailable");
      }
    })();
  }, [jobId, queryClient, urlParam, vaultId]);

  return (
    <PipelinePage
      stages={stages}
      overallDone={overallDone}
      overallError={overallError ?? resolveError}
      connected={connected}
      noJobFound={noJobFound}
    />
  );
}
