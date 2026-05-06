import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { IngestionCircle } from "@/components/ingestion-circle";
import { IngestionExpanded } from "@/components/ingestion-expanded";
import { ingestBulk } from "@/api/ingest";
import { useViewNavigate } from "@/hooks/use-view-navigate";
import type { DroppedFile } from "@/lib/types";

const EASE_OUT: [number, number, number, number] = [0.25, 1, 0.5, 1];
const LAYOUT_ID = "ingestion-zone";

export function IngestionFlow({ hasActivePipeline }: { hasActivePipeline: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pendingFilesRef = useRef<DroppedFile[]>([]);
  const pendingUrlRef = useRef<string>("");
  const zoneRef = useRef<HTMLDivElement>(null);
  const navigate = useViewNavigate();
  const prefersReducedMotion = useReducedMotion();
  const shouldAnimate = !prefersReducedMotion;

  // Document-level drag detection — expand circle when files are dragged anywhere
  useEffect(() => {
    let _dragCounter = 0;

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      _dragCounter++;
      if (!expanded) setExpanded(true);
    };

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      _dragCounter--;
    };

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      _dragCounter = 0;
    };

    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);

    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [expanded]);

  const handleCircleClick = useCallback(() => {
    if (hasActivePipeline) {
      navigate("/pipeline");
    } else {
      setExpanded(true);
    }
  }, [hasActivePipeline, navigate]);

  const handleCancel = useCallback(() => {
    setExpanded(false);
    pendingFilesRef.current = [];
    pendingUrlRef.current = "";
  }, []);

  const handleFileDrop = useCallback((files: DroppedFile[]) => {
    pendingFilesRef.current = files;
    pendingUrlRef.current = "";
  }, []);

  const handleUrlSubmit = useCallback((url: string) => {
    pendingUrlRef.current = url;
    pendingFilesRef.current = [];
  }, []);

  const handleConfirm = useCallback(async () => {
    const files = pendingFilesRef.current;
    const url = pendingUrlRef.current;

    if (files.length === 0 && !url) return;

    setConfirming(true);

    if (files.length > 0) {
      let taskId: string | null = null;
      for await (const event of ingestBulk(files.map((f) => f.file))) {
        if (event.phase === "processing" && event.task_id) {
          taskId = event.task_id;
          break;
        }
        if (event.phase === "error") {
          setConfirming(false);
          return;
        }
      }

      if (taskId) {
        navigate(`/pipeline?task_id=${taskId}&file_count=${files.length}`);
      } else {
        setConfirming(false);
      }
    } else if (url) {
      navigate(`/pipeline?url=${encodeURIComponent(url)}`);
    }
  }, [navigate]);

  if (confirming) {
    return (
      <div className="mt-10 flex justify-center" ref={zoneRef}>
        <motion.div
          layoutId={LAYOUT_ID}
          className="w-full max-w-[640px] rounded-sm border border-solid border-gold-dim
                     bg-ink-raised px-5 py-4"
          initial={shouldAnimate ? { opacity: 0, scale: 0.95 } : false}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.25, ease: EASE_OUT }}
        >
          <div className="flex items-center gap-3">
            <span className="text-gold animate-[pulse-fade_1.6s_ease-in-out_infinite] shrink-0 text-lg">
              ◉
            </span>
            <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint">
              uploading to vault…
            </span>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="mt-10 flex justify-center" ref={zoneRef}>
      <AnimatePresence mode="wait">
        {!expanded ? (
          <motion.div
            key="circle"
            initial={shouldAnimate ? { opacity: 0, scale: 0.8 } : false}
            animate={{ opacity: 1, scale: 1 }}
            exit={
              shouldAnimate ? { opacity: 0, scale: 0.8, transition: { duration: 0.15 } } : false
            }
            transition={{ duration: 0.2, ease: EASE_OUT }}
          >
            <IngestionCircle
              hasActivePipeline={hasActivePipeline}
              onClick={handleCircleClick}
              layoutId={LAYOUT_ID}
            />
          </motion.div>
        ) : (
          <motion.div
            key="expanded"
            initial={shouldAnimate ? { opacity: 0, scale: 0.95 } : false}
            animate={{ opacity: 1, scale: 1 }}
            exit={
              shouldAnimate ? { opacity: 0, scale: 0.95, transition: { duration: 0.15 } } : false
            }
            transition={{ duration: 0.25, ease: EASE_OUT }}
          >
            <IngestionExpanded
              onFileDrop={handleFileDrop}
              onUrlSubmit={handleUrlSubmit}
              onConfirm={handleConfirm}
              onCancel={handleCancel}
              layoutId={LAYOUT_ID}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
