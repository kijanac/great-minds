import { IngestionZone } from "@/components/ingestion-zone";
import { useIngestion } from "@/hooks/use-ingestion";

export function IngestionContainer() {
  const { queue, url, setUrl, handleFileDrop, handleUrlSubmit, dismissItem } = useIngestion();

  return (
    <IngestionZone
      queue={queue}
      url={url}
      onUrlChange={setUrl}
      onUrlSubmit={handleUrlSubmit}
      onFileDrop={handleFileDrop}
      onDismiss={dismissItem}
    />
  );
}
