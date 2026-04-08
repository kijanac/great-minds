import { useParams, Navigate } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { ArticleReader } from "@/containers/article-reader";

const EASE_OUT: [number, number, number, number] = [0.25, 1, 0.5, 1];

export default function DocPage() {
  const { "*": path } = useParams();
  const prefersReducedMotion = useReducedMotion();

  if (!path) return <Navigate to="/" replace />;

  return (
    <AnimatePresence initial={false}>
      <motion.div
        key={path}
        initial={prefersReducedMotion ? false : { opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        exit={
          prefersReducedMotion
            ? undefined
            : { opacity: 0, x: -16, transition: { duration: 0.15, ease: EASE_OUT } }
        }
        transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.22, ease: EASE_OUT }}
      >
        <ArticleReader path={path} />
      </motion.div>
    </AnimatePresence>
  );
}
