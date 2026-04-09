import { useNavigate } from "react-router";

import { CornerMenu } from "@/components/corner-menu";
import { useBrain } from "@/hooks/use-brain";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/hooks/use-theme";

export function CornerMenuContainer() {
  const { isAuthenticated, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { brains, activeBrainId, switchBrain, createBrain } = useBrain();
  const navigate = useNavigate();

  if (!isAuthenticated) return null;

  function handleSwitchBrain(brainId: string) {
    switchBrain(brainId);
    navigate("/");
  }

  async function handleCreateBrain(name: string) {
    await createBrain(name);
    navigate("/");
  }

  function handleProjectSettings(brainId: string) {
    navigate(`/project/${brainId}/settings`);
  }

  return (
    <CornerMenu
      theme={theme}
      onToggleTheme={toggle}
      onSignOut={logout}
      brains={brains}
      activeBrainId={activeBrainId}
      onSwitchBrain={handleSwitchBrain}
      onCreateBrain={handleCreateBrain}
      onProjectSettings={handleProjectSettings}
    />
  );
}
