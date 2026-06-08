import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

import type { CreateVaultCommand, UpdateVaultCommand } from "./schema/vault";
import type { Workspace } from "./schema/workspace";
import { bootLocalApp, localApi, restartLocalApp } from "./worker/client";

type LocalAppBootState =
  | { status: "booting" }
  | { status: "ready"; workspace: Workspace }
  | { status: "failed"; error: unknown };

type LocalAppContextValue = {
  workspace: Workspace;
  createVault: (command: CreateVaultCommand) => Promise<Workspace>;
  updateVault: (command: UpdateVaultCommand) => Promise<Workspace>;
  switchVault: (vaultId: string) => Promise<Workspace>;
  retryBoot: () => void;
};

const LocalAppContext = createContext<LocalAppContextValue | null>(null);

export function LocalAppProvider({ children }: { children: ReactNode }) {
  const [bootState, setBootState] = useState<LocalAppBootState>({
    status: "booting",
  });

  const runBoot = useCallback((mode: "initial" | "restart") => {
    setBootState({ status: "booting" });

    const bootPromise = mode === "restart" ? restartLocalApp() : bootLocalApp();

    void bootPromise.then(
      (workspace) => {
        setBootState({ status: "ready", workspace });
      },
      (error: unknown) => {
        reportLocalBootError(error);
        setBootState({ status: "failed", error });
      },
    );
  }, []);

  useEffect(() => {
    runBoot("initial");
  }, [runBoot]);

  const retryBoot = useCallback(() => {
    runBoot("restart");
  }, [runBoot]);

  const createVault = useCallback(async (command: CreateVaultCommand) => {
    const workspace = await localApi.createVault(command);
    setBootState({ status: "ready", workspace });
    return workspace;
  }, []);

  const updateVault = useCallback(async (command: UpdateVaultCommand) => {
    const workspace = await localApi.updateVault(command);
    setBootState({ status: "ready", workspace });
    return workspace;
  }, []);

  const switchVault = useCallback(async (vaultId: string) => {
    const workspace = await localApi.switchVault(vaultId);
    setBootState({ status: "ready", workspace });
    return workspace;
  }, []);

  const contextValue = useMemo<LocalAppContextValue | null>(() => {
    if (bootState.status !== "ready") return null;
    return {
      workspace: bootState.workspace,
      createVault,
      updateVault,
      switchVault,
      retryBoot,
    };
  }, [bootState, createVault, updateVault, switchVault, retryBoot]);

  if (bootState.status === "booting") {
    return <LocalBootScreen />;
  }

  if (bootState.status === "failed") {
    return <LocalBootErrorScreen error={bootState.error} onRetry={retryBoot} />;
  }

  return <LocalAppContext.Provider value={contextValue}>{children}</LocalAppContext.Provider>;
}

export function useLocalApp() {
  const context = useContext(LocalAppContext);
  if (!context) {
    throw new Error("useLocalApp must be used within LocalAppProvider");
  }
  return context;
}

function LocalBootScreen() {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
      <section className="max-w-sm text-center">
        <div className="mx-auto mb-5 size-10 animate-spin rounded-full border-2 border-muted border-t-primary" />
        <h1 className="text-lg font-semibold tracking-tight">Opening your library</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Great Minds is preparing the local database and workspace.
        </p>
      </section>
    </main>
  );
}

function LocalBootErrorScreen({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
      <section className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="rounded-full bg-destructive/10 p-2 text-destructive">
            <AlertTriangle className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-tight">
              Could not open your local library
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Great Minds could not start its local database. Your content is still stored locally.
              Try again, or restart the app if the problem persists.
            </p>
            <pre className="mt-4 max-h-40 overflow-auto rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground">
              {formatBootError(error)}
            </pre>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button onClick={onRetry}>
                <RefreshCcw aria-hidden="true" />
                Try again
              </Button>
              <Button variant="outline" onClick={() => window.location.reload()}>
                Restart app
              </Button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function formatBootError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "Unknown local database startup error";
  }
}

function reportLocalBootError(error: unknown): void {
  console.error("[local] failed to boot local app", error);
}
