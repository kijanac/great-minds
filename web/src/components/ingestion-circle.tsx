import { motion } from "motion/react";

interface IngestionCircleProps {
  hasActivePipeline: boolean;
  onClick: () => void;
  layoutId: string;
}

export function IngestionCircle({ hasActivePipeline, onClick, layoutId }: IngestionCircleProps) {
  return (
    <motion.button
      layoutId={layoutId}
      onClick={onClick}
      className="relative w-12 h-12 rounded-full border border-dashed border-ink-border
                 flex items-center justify-center
                 hover:border-gold-dim hover:scale-110
                 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold
                 transition-[border-color,transform] duration-200 ease-out
                 bg-transparent cursor-pointer group"
      aria-label="Add sources"
      whileHover={{ scale: 1.1 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      <span
        className="font-mono text-[length:var(--text-body)] text-warm-ghost
                     group-hover:text-gold transition-colors duration-200
                     leading-none select-none"
      >
        +
      </span>

      {hasActivePipeline && (
        <span
          className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-gold
                         animate-[pulse-fade_1.6s_ease-in-out_infinite]"
        />
      )}
    </motion.button>
  );
}
