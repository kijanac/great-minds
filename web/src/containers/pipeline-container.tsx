import { useEffect } from "react";
import { useSearchParams } from "react-router";

import { PipelinePage } from "@/components/pipeline-page";
import { usePipelineProgress } from "@/hooks/use-pipeline-progress";

/**
 * Pipeline container — watches the latest bulk ingest task (if any)
 * and its follow-up compile task, rendering stage-by-stage progress.
 */
export function PipelineContainer() {
  const [searchParams] = useSearchParams();
  const taskId = searchParams.get("task_id");
  const fileCount = parseInt(searchParams.get("file_count") ?? "0", 10);

  const { stages, overallDone, overallError, watchBulkTask } = usePipelineProgress();

  useEffect(() => {
    if (taskId && fileCount > 0) {
      watchBulkTask(taskId, fileCount);
    }
  }, [taskId, fileCount, watchBulkTask]);

  return <PipelinePage stages={stages} overallDone={overallDone} overallError={overallError} />;
}
