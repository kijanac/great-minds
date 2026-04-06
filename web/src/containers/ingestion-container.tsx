import { IngestionZone } from "@/components/ingestion-zone"
import { useIngestion } from "@/hooks/use-ingestion"

export function IngestionContainer() {
  const {
    status,
    resultName,
    errorMessage,
    url,
    setUrl,
    handleFileDrop,
    handleUrlSubmit,
    handleReset,
  } = useIngestion()

  return (
    <IngestionZone
      status={status}
      resultName={resultName}
      errorMessage={errorMessage}
      url={url}
      onUrlChange={setUrl}
      onUrlSubmit={handleUrlSubmit}
      onFileDrop={handleFileDrop}
      onReset={handleReset}
    />
  )
}
