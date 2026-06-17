import { useState } from "react";
import { FileX, Home, Search, Trash2 } from "lucide-react";

import type { SourceDocumentSummary, SourceTypeFacet } from "@/local/schema/source";
import type { MemberRole } from "@/local/schema/member-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { FILTER_CHIP_CLASS, POPOVER_SURFACE_CLASS } from "@/lib/control-styles";
import { formatShortDate } from "@/lib/utils";

const ALL_TYPES_VALUE = "__all";

interface SourcesPageProps {
  items: SourceDocumentSummary[];
  sourceTypes: SourceTypeFacet[];
  activeType: string | null;
  search: string;
  loading: boolean;
  hasMore: boolean;
  sourceActions?: SourceActions;
  onHome: () => void;
  onSourceClick: (path: string) => void;
  onTypeFilter: (type: string | null) => void;
  onSearchChange: (query: string) => void;
  onLoadMore: () => void;
}

interface SourceActions {
  role: MemberRole | null;
  busyPath: string | null;
  error: string | null;
  onDeleteSource?: (path: string) => Promise<void>;
  onRequestDeletion?: (path: string) => Promise<void>;
}

export function SourcesPage({
  items,
  sourceTypes,
  activeType,
  search,
  loading,
  hasMore,
  sourceActions,
  onHome,
  onSourceClick,
  onTypeFilter,
  onSearchChange,
  onLoadMore,
}: SourcesPageProps) {
  const totalCount = sourceTypes.reduce((sum, ct) => sum + ct.count, 0);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center justify-between px-4 md:px-6 pt-4 pb-3 border-b border-ink-subtle gap-3">
        <div className="flex items-center gap-4 shrink-0">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onHome}
            className="text-muted-foreground hover:text-gold hover:bg-transparent"
          >
            <Home size={14} />
          </Button>
          <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase hidden md:inline">
            sources
          </span>
        </div>

        <div className="flex items-center gap-2 max-w-[300px] w-full">
          <Search size={14} className="text-muted-foreground shrink-0" />
          <Input
            className="h-7 bg-transparent dark:bg-transparent border-ink-border rounded-sm font-serif text-[length:var(--text-small)] text-foreground px-3 caret-gold placeholder:text-input focus-visible:ring-0 focus-visible:border-gold-dim"
            placeholder="Search sources..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[740px] mx-auto px-4 md:px-10 pt-8 pb-20">
          {sourceTypes.length > 0 && (
            <ToggleGroup
              multiple={false}
              value={[activeType ?? ALL_TYPES_VALUE]}
              onValueChange={(vals) => {
                const next = vals[0];
                onTypeFilter(!next || next === ALL_TYPES_VALUE ? null : next);
              }}
              variant="outline"
              size="sm"
              className="mb-8 flex-wrap"
            >
              <ToggleGroupItem value={ALL_TYPES_VALUE} className={FILTER_CHIP_CLASS}>
                all · {totalCount}
              </ToggleGroupItem>
              {sourceTypes.map((ct) => (
                <ToggleGroupItem key={ct.value} value={ct.value} className={FILTER_CHIP_CLASS}>
                  {ct.value} · {ct.count}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}

          {loading && items.length === 0 && (
            <div className="space-y-3">
              {[0, 1, 2, 3].map((idx) => (
                <div key={idx} className="flex items-center justify-between gap-4 px-3 py-2.5">
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-5 w-2/3 bg-ink-raised" />
                    <Skeleton className="h-3 w-1/2 bg-ink-raised" />
                  </div>
                  <Skeleton className="h-3 w-16 bg-ink-raised" />
                </div>
              ))}
            </div>
          )}

          {!loading && items.length === 0 && (
            <div className="text-center pt-8">
              <p className="font-serif text-[length:var(--text-body)] text-warm-dim mb-2">
                {search ? "No sources match your search" : "No sources yet"}
              </p>
              {!search && (
                <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost">
                  drop files on the explore page to ingest sources
                </p>
              )}
            </div>
          )}

          {sourceActions?.error && (
            <p className="mb-3 px-3 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-destructive">
              {sourceActions.error}
            </p>
          )}

          {items.length > 0 && (
            <div className="space-y-1">
              {items.map((item) => (
                <div
                  key={item.filePath}
                  className="group flex min-h-12 items-center gap-2 rounded-sm hover:bg-ink-raised"
                >
                  <button
                    type="button"
                    onClick={() => onSourceClick(item.filePath)}
                    className="flex min-w-0 flex-1 items-center justify-between gap-4 py-2.5 pl-3 pr-1 text-left"
                  >
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="w-full truncate font-serif text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-warm">
                        {item.title ?? item.filePath}
                      </span>
                      {(item.author || item.origin) && (
                        <span className="w-full truncate font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost">
                          {[item.author, item.origin].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </div>
                    <span className="shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost">
                      {formatShortDate(item.updatedAt)}
                    </span>
                  </button>
                  {sourceActions && <SourceActionButton item={item} actions={sourceActions} />}
                </div>
              ))}
            </div>
          )}

          {hasMore && !loading && (
            <div className="mt-6 text-center">
              <Button
                variant="ghost"
                onClick={onLoadMore}
                className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:text-gold hover:bg-transparent h-auto px-3 py-1.5"
              >
                load more
              </Button>
            </div>
          )}

          {loading && items.length > 0 && (
            <div className="mt-6 space-y-2 px-3">
              <Skeleton className="h-4 w-1/2 bg-ink-raised" />
              <Skeleton className="h-4 w-2/3 bg-ink-raised" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceActionButton({
  item,
  actions,
}: {
  item: SourceDocumentSummary;
  actions: SourceActions;
}) {
  const [open, setOpen] = useState(false);
  const pending = actions.busyPath === item.filePath;
  const title = item.title ?? item.filePath;

  const action =
    actions.role === "owner" && actions.onDeleteSource
      ? {
          label: "delete source",
          icon: Trash2,
          title: "Delete this source?",
          description:
            "This removes the source and search entries now. Existing compiled wiki pages will stay as-is until a future compile.",
          confirm: "delete source",
          onConfirm: actions.onDeleteSource,
        }
      : actions.role === "editor" && actions.onRequestDeletion
        ? {
            label: "request deletion",
            icon: FileX,
            title: "Request source deletion?",
            description: "An owner can review this request from proposals.",
            confirm: "request deletion",
            onConfirm: actions.onRequestDeletion,
          }
        : null;

  if (!action) return null;

  const confirmedAction = action;
  const Icon = action.icon;

  async function handleConfirm() {
    try {
      await confirmedAction.onConfirm(item.filePath);
      setOpen(false);
    } catch {
      // Container owns the displayed error state.
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={action.label}
            disabled={pending}
            className="mr-2 shrink-0 text-warm-ghost hover:bg-transparent hover:text-gold"
          />
        }
      >
        <Icon className="size-3.5" />
      </AlertDialogTrigger>
      <AlertDialogContent className={POPOVER_SURFACE_CLASS}>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-serif text-[length:var(--text-body)] text-warm">
            {action.title}
          </AlertDialogTitle>
          <AlertDialogDescription className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost">
            {action.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="rounded-sm border border-gold-dim/70 bg-gold/5 px-3 py-2">
          <p className="truncate font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-gold-muted">
            {title}
          </p>
          <p className="mt-1 truncate font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost">
            {item.filePath}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={pending}
            className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
          >
            cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(e) => {
              e.preventDefault();
              void handleConfirm();
            }}
            className="border border-gold-dim bg-gold/10 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold hover:bg-gold/20 disabled:opacity-40"
          >
            {pending ? "working..." : action.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
