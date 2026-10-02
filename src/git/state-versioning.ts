/**
 * State Versioning
 *
 * Version control the automaton's own state files (~/.automaton/).
 * Every self-modification triggers a git commit with a descriptive message.
 * The automaton's entire identity history is version-controlled and replayable.
 */

import type { ConwayClient, AutomatonDatabase } from "../types.js";
import { gitInit, gitCommit, gitStatus, gitLog } from "./tools.js";

const AUTOMATON_DIR = "~/.automaton";

function resolveHome(p: string): string {
  const home = process.env.HOME || "/root";
  if (p.startsWith("~")) {
    return `${home}${p.slice(1)}`;
  }
  return p;
}

/**
 * Initialize git repo for the automaton's state directory.
 * Creates .gitignore to exclude sensitive files.
 */
export async function initStateRepo(
  conway: ConwayClient,
): Promise<void> {
  const dir = resolveHome(AUTOMATON_DIR);

  // Git is a runtime dependency in sovereign mode. Fail loudly if it is missing
  // instead of leaving a half-initialized .git directory behind.
  const versionCheck = await conway.exec("git --version", 5000);
  if (versionCheck.exitCode !== 0) {
    throw new Error(
      `Git is unavailable in the runtime: ${versionCheck.stderr || versionCheck.stdout || "git --version failed"}`,
    );
  }

  // Initialize only when the state repository does not exist yet. If a previous
  // boot created .git but failed before the first commit, continue initialization
  // and finish the genesis commit on the next boot.
  const checkResult = await conway.exec(
    `test -d ${dir}/.git && echo "exists" || echo "nope"`,
    5000,
  );

  if (checkResult.stdout.trim() !== "exists") {
    await gitInit(conway, dir);
  }

  // Create .gitignore for sensitive files. This is intentionally rewritten on
  // startup so older state repositories receive the current protection list.
  const gitignore = `# Sensitive files - never commit
wallet.json
automaton.json
inference-providers.json
sovereign-runtime.json
state.db
state.db-wal
state.db-shm
logs/
*.log
*.err

# Runtime-generated data — keep the state repo small and fast
sandboxes/
skills/
cache/
tmp/
`;

  await conway.writeFile(`${dir}/.gitignore`, gitignore);

  // Configure git user and mark the runtime state repository as safe.
  // Railway can reuse a filesystem owned by a different UID; Git may then
  // refuse the commit even though the repository itself is valid.
  const configResult = await conway.exec(
    `git config --global --add safe.directory "${dir}" && cd ${dir} && git config --local user.name "Automaton" && git config --local user.email "automaton@conway.tech" && rm -f .git/index.lock .git/config.lock .git/HEAD.lock`,
    5000,
  );
  if (configResult.exitCode !== 0) {
    throw new Error(
      `Git configuration failed: ${configResult.stderr || configResult.stdout || "git config failed"}`,
    );
  }

  // A repository can exist without any commit when an earlier boot failed.
  // Commit only when HEAD is missing; otherwise leave its history untouched.
  const headCheck = await conway.exec(
    `cd ${dir} && git rev-parse --verify HEAD >/dev/null 2>&1`,
    5000,
  );
  if (headCheck.exitCode !== 0) {
    await gitCommit(conway, dir, "genesis: automaton state repository initialized");
  }
}

/**
 * Commit a state change with a descriptive message.
 * Called after any self-modification.
 */
export async function commitStateChange(
  conway: ConwayClient,
  description: string,
  category: string = "state",
): Promise<string> {
  const dir = resolveHome(AUTOMATON_DIR);

  // Check if there are changes
  const status = await gitStatus(conway, dir);
  if (status.clean) {
    return "No changes to commit";
  }

  const message = `${category}: ${description}`;
  const result = await gitCommit(conway, dir, message);
  return result;
}

/**
 * Commit after a SOUL.md update.
 */
export async function commitSoulUpdate(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "soul");
}

/**
 * Commit after a skill installation or removal.
 */
export async function commitSkillChange(
  conway: ConwayClient,
  skillName: string,
  action: "install" | "remove" | "update",
): Promise<string> {
  return commitStateChange(
    conway,
    `${action} skill: ${skillName}`,
    "skill",
  );
}

/**
 * Commit after heartbeat config change.
 */
export async function commitHeartbeatChange(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "heartbeat");
}

/**
 * Commit after config change.
 */
export async function commitConfigChange(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "config");
}

/**
 * Get the state repo history.
 */
export async function getStateHistory(
  conway: ConwayClient,
  limit: number = 20,
) {
  const dir = resolveHome(AUTOMATON_DIR);
  return gitLog(conway, dir, limit);
}
