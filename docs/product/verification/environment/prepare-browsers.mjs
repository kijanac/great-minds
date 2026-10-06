import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const environmentDir = dirname(fileURLToPath(import.meta.url));
const stateDir = join(environmentDir, ".state");
const manifestPath = join(stateDir, "manifest.json");
const browserDir = join(stateDir, "browser");
const webUrl = "http://localhost:5173";

if (!existsSync(manifestPath)) {
  throw new Error("Verification manifest is missing; run `node manage.mjs start` first");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
mkdirSync(browserDir, { recursive: true });

const run = (session, args, { allowFailure = false, capture = false } = {}) => {
  const result = spawnSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `agent-browser ${args.join(" ")} failed for ${session}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout?.trim() ?? "";
};

const waitForHome = async (session) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const url = run(session, ["get", "url"], { capture: true });
    if (url === `${webUrl}/` || url === webUrl) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  const snapshot = run(session, ["snapshot", "-i"], { capture: true, allowFailure: true });
  throw new Error(`${session} did not reach Home after suppressed-auth sign-in:\n${snapshot}`);
};

const profiles = [
  { role: "owner", session: "gm-verification-owner", vaultId: manifest.vaults.primary.id },
  { role: "editor", session: "gm-verification-editor", vaultId: manifest.vaults.primary.id },
  { role: "viewer", session: "gm-verification-viewer", vaultId: manifest.vaults.primary.id },
  {
    role: "nonmember",
    session: "gm-verification-nonmember",
    vaultId: manifest.accounts.nonmember.default_vault_id,
  },
];

for (const profile of profiles) {
  const account = manifest.accounts[profile.role];
  run(profile.session, ["close"], { allowFailure: true, capture: true });
  run(profile.session, ["open", `${webUrl}/login`]);
  run(profile.session, ["eval", "localStorage.clear(); location.assign('/login')"]);
  run(profile.session, ["wait", "500"]);
  run(profile.session, ["find", "placeholder", "you@example.com", "fill", account.email]);
  run(profile.session, ["find", "role", "button", "click", "--name", "Send code"]);
  await waitForHome(profile.session);
  run(profile.session, [
    "eval",
    `localStorage.setItem('vault_id', '${profile.vaultId}'); window.dispatchEvent(new Event('auth:changed')); location.assign('/')`,
  ]);
  run(profile.session, ["wait", "1200"]);
  const activeVault = run(profile.session, ["eval", "localStorage.getItem('vault_id')"], {
    capture: true,
  });
  if (!activeVault.includes(profile.vaultId)) {
    throw new Error(`${profile.session} did not retain expected active vault ${profile.vaultId}`);
  }
  const statePath = join(browserDir, `${profile.role}.json`);
  run(profile.session, ["state", "save", statePath]);
  console.log(
    JSON.stringify({
      event: "browser_profile_ready",
      role: profile.role,
      session: profile.session,
      state: statePath,
      active_vault_id: profile.vaultId,
    }),
  );
}
