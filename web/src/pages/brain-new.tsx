import { useNavigate } from "react-router";

import {
  BrainConfigForm,
  type BrainConfigFormSubmit,
} from "@/components/brain-config-form";
import { useBrains, useCreateBrain } from "@/hooks/use-brain";

export default function BrainNewPage() {
  const navigate = useNavigate();
  const { data: brains } = useBrains();
  const createBrain = useCreateBrain();

  const isFirstRun = (brains?.length ?? 0) === 0;

  async function handleSubmit(data: BrainConfigFormSubmit) {
    if (!data.name) return;
    await createBrain.mutateAsync({
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

        <BrainConfigForm
          mode="create"
          submitting={createBrain.isPending}
          onSubmit={handleSubmit}
          onCancel={isFirstRun ? undefined : () => navigate("/")}
          submitLabel="create project"
        />

        {createBrain.error && (
          <p className="mt-4 font-mono text-[length:var(--text-chrome)] text-red-400">
            {createBrain.error.message}
          </p>
        )}
      </div>
    </div>
  );
}
