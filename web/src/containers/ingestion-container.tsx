import { IngestionZone } from "@/components/ingestion-zone";
import { useIngestion } from "@/hooks/use-ingestion";

export function IngestionContainer() {
  const {
    queue,
    summary,
    taskProgress,
    url,
    setUrl,
    handleFileDrop,
    handleUrlSubmit,
    dismissItem,
    compileIntentIds,
    dismissCompileIntent,
  } = useIngestion();

  return (
    <IngestionZone
      queue={queue}
      summary={summary}
      taskProgress={taskProgress}
      url={url}
      onUrlChange={setUrl}
      onUrlSubmit={handleUrlSubmit}
      onFileDrop={handleFileDrop}
      onDismiss={dismissItem}
      compileIntentIds={compileIntentIds}
      onDismissCompile={dismissCompileIntent}
    />
  );
}
