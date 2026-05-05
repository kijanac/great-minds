import { useNavigate } from "react-router";

import { VaultConfigForm, type VaultConfigFormSubmit } from "@/components/vault-config-form";
import { useVaults, useCreateVault } from "@/hooks/use-vault";

export default function VaultNewPage() {
  const navigate = useNavigate();
  const { data: vaults } = useVaults();
  const createVault = useCreateVault();

  const isFirstRun = (vaults?.length ?? 0) === 0;

  async function handleSubmit(data: VaultConfigFormSubmit) {
    if (!data.name) return;
    await createVault.mutateAsync({
      name: data.name,
      thematic_hint: data.thematic_hint || undefined,
    });
    navigate("/");
  }

  return (
    <div className="min-h-screen flex items-start justify-center px-4 md:px-10 pt-16 pb-20">
      <div className="w-full max-w-[640px]">
        <h1 className="font-serif text-[length:var(--text-title)] text-foreground leading-[1.15] mb-2">
          {isFirstRun ? "Name your first project" : "New project"}
        </h1>
        <p className="font-mono text-[length:var(--text-caption)] tracking-[0.1em] text-warm-ghost mb-10">
          {isFirstRun
            ? "a library of sources you can ask across"
            : "set up a new library of sources"}
        </p>

        <VaultConfigForm
          mode="create"
          submitting={createVault.isPending}
          onSubmit={handleSubmit}
          onCancel={isFirstRun ? undefined : () => navigate("/")}
          submitLabel="create project"
        />

        {createVault.error && (
          <p className="mt-4 font-mono text-[length:var(--text-chrome)] text-red-400">
            {createVault.error.message}
          </p>
        )}
      </div>
    </div>
  );
}
