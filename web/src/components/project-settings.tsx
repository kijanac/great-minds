import { useState, type ReactNode } from "react";
import { Home, X } from "lucide-react";

import type { VaultConfig, VaultDetail, Membership } from "@/api/vaults";
import { VaultConfigForm, type VaultConfigFormSubmit } from "@/components/vault-config-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Skeleton } from "@/components/ui/skeleton";
import { POPOVER_SURFACE_CLASS } from "@/lib/control-styles";

interface ProjectSettingsProps {
  project: VaultDetail | null;
  members: Membership[];
  config: VaultConfig | null;
  isOwner: boolean;
  loading: boolean;
  proposalsSlot: ReactNode;
  apiKeysSlot: ReactNode;
  onHome: () => void;
  onInvite: (email: string) => Promise<void>;
  onChangeRole: (userId: string, role: string) => Promise<void>;
  onRemoveMember: (userId: string) => Promise<void>;
  onSaveConfig: (thematic_hint: string) => Promise<void>;
  onDeleteVault: () => Promise<void>;
}

export function ProjectSettings({
  project,
  members,
  config,
  isOwner,
  loading,
  proposalsSlot,
  apiKeysSlot,
  onHome,
  onInvite,
  onChangeRole,
  onRemoveMember,
  onSaveConfig,
  onDeleteVault,
}: ProjectSettingsProps) {
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setInviting(true);
    try {
      await onInvite(trimmed);
      setEmail("");
    } finally {
      setInviting(false);
    }
  }

  async function handleSaveConfig(data: VaultConfigFormSubmit) {
    setSavingConfig(true);
    try {
      await onSaveConfig(data.thematic_hint);
    } finally {
      setSavingConfig(false);
    }
  }

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
            settings
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[740px] mx-auto px-4 md:px-10 pt-8 pb-20">
          {loading || !project ? (
            <div className="space-y-6">
              <div className="space-y-2">
                <Skeleton className="h-9 w-48 bg-ink-raised" />
                <Skeleton className="h-4 w-36 bg-ink-raised" />
              </div>
              <div className="space-y-3">
                <Skeleton className="h-4 w-24 bg-ink-raised" />
                <Skeleton className="h-10 w-full bg-ink-raised" />
                <Skeleton className="h-10 w-5/6 bg-ink-raised" />
              </div>
            </div>
          ) : (
            <>
              <h1 className="font-serif text-[length:var(--text-heading)] text-warm mb-1">
                {project.name}
              </h1>
              <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost mb-8">
                {project.article_count} articles · {project.member_count} member
                {project.member_count !== 1 && "s"}
              </p>

              <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
                members
              </h2>

              <div className="space-y-1 mb-6">
                {members.map((m) => (
                  <div
                    key={m.user_id}
                    className="flex items-center justify-between py-2 px-3 rounded-sm hover:bg-ink-raised group"
                  >
                    <span className="font-mono text-[length:var(--text-small)] text-warm-dim">
                      {m.email}
                    </span>
                    <div className="flex items-center gap-2">
                      {isOwner && m.role !== "owner" ? (
                        <Select
                          value={m.role}
                          onValueChange={(role) => role && onChangeRole(m.user_id, role)}
                        >
                          <SelectTrigger
                            size="sm"
                            className="h-7 w-24 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className={POPOVER_SURFACE_CLASS}>
                            <SelectItem value="editor">editor</SelectItem>
                            <SelectItem value="viewer">viewer</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost">
                          {m.role}
                        </span>
                      )}
                      {isOwner && m.role !== "owner" && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => onRemoveMember(m.user_id)}
                          className="text-warm-ghost hover:text-red-400 hover:bg-transparent opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X size={12} />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {isOwner && (
                <form onSubmit={handleInvite} className="flex items-center gap-3">
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="invite by email"
                    disabled={inviting}
                    className="h-8 bg-transparent dark:bg-transparent border-ink-border rounded-sm font-mono text-[length:var(--text-small)] text-warm px-3 caret-gold placeholder:text-warm-ghost focus-visible:ring-0 focus-visible:border-gold-dim"
                  />
                  <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost shrink-0">
                    ↵
                  </span>
                </form>
              )}

              {config && (
                <div className="mt-12">
                  <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
                    configuration
                  </h2>
                  <VaultConfigForm
                    mode="edit"
                    initialThematicHint={config.thematic_hint}
                    submitting={savingConfig}
                    onSubmit={handleSaveConfig}
                    submitLabel="save changes"
                  />
                </div>
              )}

              {proposalsSlot}
              {apiKeysSlot}

              {isOwner && (
                <div className="mt-16 pt-8 border-t border-ink-border">
                  <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-red-400/70 uppercase mb-4">
                    danger zone
                  </h2>
                  <p className="text-[length:var(--text-small)] text-warm-ghost mb-4 leading-relaxed">
                    Permanently delete this vault, all its documents, wiki articles, and R2 storage.
                    This cannot be undone.
                  </p>
                  <DeleteVaultButton onDelete={onDeleteVault} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DeleteVaultButton({ onDelete }: { onDelete: () => Promise<void> }) {
  const [deleting, setDeleting] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canDelete = confirmation === "delete";

  function handleOpenChange(nextOpen: boolean) {
    if (deleting) return;
    setOpen(nextOpen);
    if (!nextOpen) {
      setConfirmation("");
      setError(null);
    }
  }

  async function handleDelete() {
    if (!canDelete || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
      setOpen(false);
      setConfirmation("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete vault.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            className="h-auto px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-red-400/70 hover:text-red-400 hover:bg-red-400/5 rounded-sm"
          />
        }
      >
        delete vault
      </AlertDialogTrigger>
      <AlertDialogContent className={POPOVER_SURFACE_CLASS}>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-serif text-[length:var(--text-body)] text-warm">
            Delete this vault?
          </AlertDialogTitle>
          <AlertDialogDescription className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost">
            This permanently deletes the vault, all its documents, wiki articles, and R2 storage.
            This cannot be undone. Type <span className="text-red-400">delete</span> to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Input
            autoFocus
            disabled={deleting}
            value={confirmation}
            onChange={(e) => {
              setConfirmation(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canDelete && !deleting) {
                e.preventDefault();
                void handleDelete();
              }
            }}
            className="h-8 bg-transparent dark:bg-transparent border-red-400/30 rounded-sm font-mono text-[length:var(--text-small)] text-red-400 px-3 caret-red-400 placeholder:text-red-400/30 focus-visible:ring-0 focus-visible:border-red-400/60"
            placeholder="delete"
          />
          {error && (
            <Alert variant="destructive" className="rounded-sm border-red-400/25 bg-red-400/5">
              <AlertDescription className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-red-400/90">
                {error}
              </AlertDescription>
            </Alert>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={deleting}
            className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
          >
            cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={deleting || !canDelete}
            onClick={(e) => {
              e.preventDefault();
              void handleDelete();
            }}
            className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] bg-red-400/10 text-red-400 hover:bg-red-400/20 border border-red-400/30 disabled:opacity-40"
          >
            {deleting ? "deleting…" : "delete vault"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
