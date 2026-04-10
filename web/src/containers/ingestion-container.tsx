import { IngestionZone } from "@/components/ingestion-zone";
import { useIngestion } from "@/hooks/use-ingestion";

export function IngestionContainer() {
  const { queue, summary, url, setUrl, handleFileDrop, handleUrlSubmit, dismissItem } =
    useIngestion();

  return (
    <IngestionZone
      queue={queue}
      summary={summary}
      url={url}
      onUrlChange={setUrl}
      onUrlSubmit={handleUrlSubmit}
      onFileDrop={handleFileDrop}
      onDismiss={dismissItem}
    />
  );
}
