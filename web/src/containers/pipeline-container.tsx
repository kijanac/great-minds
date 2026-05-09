import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router";

import { listJobs, startUrlJob } from "@/api/jobs";
import { PipelinePage } from "@/components/pipeline-page";
import { useActiveVaultId } from "@/hooks/use-vault";
import { useJobSSE } from "@/hooks/use-job-sse";

export function PipelineContainer() {
  const { jobId: routeJobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlParam = searchParams.get("url");
  const queryClient = useQueryClient();
  const vaultId = useActiveVaultId();

  const [resolvedJobId, setResolvedJobId] = useState<string | null>(null);
  const [noJobFound, setNoJobFound] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const jobId = routeJobId ?? resolvedJobId;
  const { stages, overallDone, overallError, connected } = useJobSSE(jobId);

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
          setResolvedJobId(run.id);
          navigate(`/pipeline/runs/${run.id}`, { replace: true });
          return;
        }

        const activeJobs = await listJobs("active");
        if (activeJobs.items.length === 1) {
          const activeJobId = activeJobs.items[0].id;
          setResolvedJobId(activeJobId);
          navigate(`/pipeline/runs/${activeJobId}`, { replace: true });
        } else {
          setNoJobFound(true);
        }
      } catch (e) {
        setResolveError(e instanceof Error ? e.message : "Job unavailable");
      }
    })();
  }, [jobId, navigate, queryClient, routeJobId, urlParam, vaultId]);

  return (
    <PipelinePage
      stages={stages}
      overallDone={overallDone}
      overallError={overallError ?? resolveError}
      connected={connected}
      noJobFound={!jobId && noJobFound}
    />
  );
}
