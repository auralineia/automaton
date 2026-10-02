/**
 * Built-in RITTY skills.
 *
 * These are deliberately local and small: they give a fresh sovereign runtime
 * a useful operating baseline without requiring network access or a remote
 * skills repository. They are written to ~/.automaton/skills on first boot and
 * then handled by the normal, sandboxed skill loader.
 */

import fs from "node:fs";
import path from "node:path";
import type { AutomatonDatabase } from "../types.js";

export interface DefaultSkill {
  name: string;
  description: string;
  instructions: string;
}

export const DEFAULT_SKILLS: DefaultSkill[] = [
  {
    name: "autonomous-execution",
    description: "Turn every wake cycle into concrete, measurable progress.",
    instructions:
      "On every wake cycle, inspect the current state and select one concrete task that advances the creator's purpose. Prefer actions that produce a file, code change, researched finding, validated integration, or another durable artifact. Avoid repeated status checks when the result is already known. When blocked, identify the smallest useful unblock action; when no useful action is available, record the blocker and sleep rather than wasting inference budget. Never spend money, transfer funds, register domains, or make irreversible external changes merely to appear productive.",
  },
  {
    name: "software-builder",
    description: "Build and improve software safely inside the available workspace.",
    instructions:
      "When a software task is appropriate, inspect before editing, make the smallest coherent change, run available type/build checks, and verify the result with a focused command or test. Prefer reusable artifacts over explanations. Keep safety and policy code intact, do not weaken security controls to make a task easier, and stop when the task is complete or a real dependency is missing. Record the result in memory when it will help future cycles avoid repeating the same work.",
  },
  {
    name: "opportunity-research",
    description: "Find legitimate opportunities to create value without spam or deception.",
    instructions:
      "Research practical opportunities where the automaton can create something people voluntarily value: software, automation, research, data products, content, or services. Prefer opportunities that can be tested with little or no spend. Separate verified facts from assumptions, avoid spam, impersonation, fraud, manipulation, or unauthorized access, and do not commit to purchases or financial transactions. Turn useful research into a concrete artifact, proposal, prototype, or next action rather than leaving it as idle notes.",
  },
];

function resolveHome(p: string): string {
  if (p.startsWith("~")) return path.join(process.env.HOME || "/root", p.slice(1));
  return p;
}

/**
 * Create only missing built-in skills. Existing DB state is never overwritten,
 * so a creator-disabled skill remains disabled.
 */
export function ensureDefaultSkills(
  skillsDir: string,
  db: AutomatonDatabase,
): number {
  const resolvedDir = resolveHome(skillsDir);
  fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });

  let created = 0;

  for (const skill of DEFAULT_SKILLS) {
    const existing = db.getSkillByName(skill.name);
    const skillDir = path.join(resolvedDir, skill.name);
    const skillPath = path.join(skillDir, "SKILL.md");

    if (existing || fs.existsSync(skillPath)) {
      continue;
    }

    fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });

    const markdown = [
      "---",
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      "auto-activate: true",
      "---",
      "",
      skill.instructions,
      "",
    ].join("\n");

    fs.writeFileSync(skillPath, markdown, {
      encoding: "utf-8",
      mode: 0o600,
    });
    created += 1;
  }

  return created;
}
