import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";

import { ingestFiles, type HashedFile } from "@/api/ingest";
import { cancelJob, listJobs, requestCompile, startUrlJob } from "@/api/jobs";
import { fetchArticlesByRun } from "@/api/wiki";
import { PipelinePage } from "@/components/pipeline-page";
import { useActiveVaultId } from "@/hooks/use-vault";
import { buildClientUploadStages, useJobSSE } from "@/hooks/use-job-sse";

interface StagedUploadState {
  uploadFiles?: HashedFile[];
  stableJobId?: string;
}

export function PipelineContainer() {
  const { jobId: routeJobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlParam = searchParams.get("url");
  const location = useLocation();
  const stagedUpload = (location.state ?? null) as StagedUploadState | null;
  const queryClient = useQueryClient();
  const vaultId = useActiveVaultId();

  const [resolvedJobId, setResolvedJobId] = useState<string | null>(null);
  const [noJobFound, setNoJobFound] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [clientUpload, setClientUpload] = useState<{
    uploaded: number;
    total: number;
  } | null>(null);
  const startedRef = useRef(false);

  const jobId = routeJobId ?? resolvedJobId;
  const {
    stages: sseStages,
    overallDone,
    overallError,
    overallCancelled,
    connected,
  } = useJobSSE(jobId);

  const stages = useMemo(() => {
    if (!jobId && clientUpload) {
      return buildClientUploadStages(clientUpload.uploaded, clientUpload.total);
    }
    return sseStages;
  }, [clientUpload, jobId, sseStages]);

  // Once the compile finishes, pull the articles this run produced so the
  // completion card shows what was built rather than how many phases ran.
  const { data: result } = useQuery({
    queryKey: ["vault", vaultId, "compile-result", jobId],
    queryFn: () => fetchArticlesByRun(jobId!),
    enabled: overallDone && !!vaultId && !!jobId,
  });

  useEffect(() => {
    if (startedRef.current || jobId) return;
    startedRef.current = true;

    (async () => {
      try {
        const upload = stagedUpload?.uploadFiles;
        if (upload && upload.length > 0 && stagedUpload?.stableJobId) {
          setClientUpload({ uploaded: 0, total: upload.length });
          for await (const event of ingestFiles(upload, stagedUpload.stableJobId)) {
            if (event.phase === "uploading") {
              setClientUpload({ uploaded: event.uploaded, total: event.total });
            } else if (event.phase === "processing") {
              if (event.id) {
                setResolvedJobId(event.id);
                if (vaultId) {
                  queryClient.invalidateQueries({
                    queryKey: ["vault", vaultId, "active-job"],
                  });
                }
                navigate(`/pipeline/runs/${event.id}`, { replace: true, state: null });
              } else {
                setResolveError("No job was created — the server may be unavailable.");
              }
              setClientUpload(null);
              return;
            } else if (event.phase === "error") {
              setResolveError(event.error ?? "Upload failed");
              setClientUpload(null);
              return;
            }
          }
          return;
        }

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
        setClientUpload(null);
      }
    })();
  }, [jobId, navigate, queryClient, routeJobId, stagedUpload, urlParam, vaultId]);

  const handleCancel = useCallback(async () => {
    if (jobId) await cancelJob(jobId);
  }, [jobId]);

  const handleRetry = useCallback(async () => {
    const job = await requestCompile();
    navigate(`/pipeline/runs/${job.id}`, { replace: true });
  }, [navigate]);

  return (
    <PipelinePage
      stages={stages}
      overallDone={overallDone}
      overallError={overallError ?? resolveError}
      overallCancelled={overallCancelled}
      connected={connected}
      noJobFound={!jobId && !clientUpload && noJobFound}
      result={result}
      onCancel={jobId ? handleCancel : undefined}
      onRetry={handleRetry}
    />
  );
}
