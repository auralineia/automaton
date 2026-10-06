import fs from "node:fs";
import path from "node:path";
import { exec as execCb } from "node:child_process";
import { ulid } from "ulid";
import type { AutomatonDatabase } from "../types.js";
import type { ConwayClient } from "../types.js";
import { AgentWorkspace } from "./workspace.js";

export type WorkStatus =
  | "planned"
  | "in_progress"
  | "blocked"
  | "paused"
  | "interrupted"
  | "completed"
  | "failed";

export interface WorkItem {
  id: string;
  goalId?: string | null;
  title: string;
  description: string;
  type: string;
  status: WorkStatus;
  workspacePath: string;
  repoPath?: string | null;
  customer?: string | null;
  successCriteria?: string | null;
  summary?: string | null;
  resumeCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  lastCheckpoint?: {
    id: string;
    stage: string;
    status: string;
    note: string;
    createdAt: string;
  } | null;
}

function now(): string {
  return new Date().toISOString();
}

function workRoot(): string {
  return process.env.RITTY_WORK_ROOT || path.join(process.env.HOME || "/root", ".automaton", "work");
}

export function ensureWorkSchema(db: AutomatonDatabase | import("better-sqlite3").Database): void {
  const raw = "raw" in db ? db.raw : db;
  raw.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      goal_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'digital-work',
      status TEXT NOT NULL DEFAULT 'planned',
      workspace_path TEXT NOT NULL,
      repo_path TEXT,
      customer TEXT,
      success_criteria TEXT,
      summary TEXT,
      resume_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      last_checkpoint_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_work_items_status_updated
      ON work_items(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS work_checkpoints (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_checkpoints_work_created
      ON work_checkpoints(work_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS work_artifacts (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'deliverable',
      label TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_artifacts_work_created
      ON work_artifacts(work_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS work_tests (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_tests_work_created
      ON work_tests(work_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS work_publish_runs (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL,
      url TEXT,
      output TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_publish_work_created
      ON work_publish_runs(work_id, created_at DESC);
  `);
  fs.mkdirSync(workRoot(), { recursive: true });
}

function normalizeWorkId(id: string): string {
  const value = id.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid work id: ${id}`);
  }
  return value;
}

function readWorkRow(raw: import("better-sqlite3").Database, id: string): WorkItem | null {
  const row = raw.prepare(`
    SELECT w.*,
      c.id AS cp_id,c.stage AS cp_stage,c.status AS cp_status,c.note AS cp_note,c.created_at AS cp_created_at
    FROM work_items w
    LEFT JOIN work_checkpoints c
      ON c.id = w.last_checkpoint_id
    WHERE w.id=?
  `).get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    goalId: row.goal_id,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    workspacePath: row.workspace_path,
    repoPath: row.repo_path,
    customer: row.customer,
    successCriteria: row.success_criteria,
    summary: row.summary,
    resumeCount: Number(row.resume_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastCheckpoint: row.cp_id
      ? {
          id: row.cp_id,
          stage: row.cp_stage,
          status: row.cp_status,
          note: row.cp_note,
          createdAt: row.cp_created_at,
        }
      : null,
  };
}

function rawOf(db: AutomatonDatabase | import("better-sqlite3").Database): import("better-sqlite3").Database {
  return "raw" in db ? db.raw : db;
}

export function getWork(db: AutomatonDatabase | import("better-sqlite3").Database, workId: string): WorkItem | null {
  ensureWorkSchema(db);
  return readWorkRow(rawOf(db), normalizeWorkId(workId));
}

export function listWorks(
  db: AutomatonDatabase | import("better-sqlite3").Database,
  options: { status?: WorkStatus; limit?: number } = {},
): WorkItem[] {
  ensureWorkSchema(db);
  const raw = rawOf(db);
  const limit = Math.max(1, Math.min(100, Number(options.limit || 30)));
  const rows = options.status
    ? raw.prepare("SELECT id FROM work_items WHERE status=? ORDER BY updated_at DESC LIMIT ?").all(options.status, limit) as any[]
    : raw.prepare("SELECT id FROM work_items ORDER BY updated_at DESC LIMIT ?").all(limit) as any[];
  return rows.map((row) => readWorkRow(raw, String(row.id))).filter((x): x is WorkItem => Boolean(x));
}

export function createWork(
  db: AutomatonDatabase | import("better-sqlite3").Database,
  input: {
    title: string;
    description: string;
    type?: string;
    goalId?: string;
    repoPath?: string;
    customer?: string;
    successCriteria?: string;
    workspacePath?: string;
  },
): WorkItem {
  ensureWorkSchema(db);
  const raw = rawOf(db);
  const id = `work-${ulid().toLowerCase()}`;
  const workspacePath = input.workspacePath
    ? path.resolve(input.workspacePath)
    : path.join(workRoot(), id);
  fs.mkdirSync(workspacePath, { recursive: true });

  raw.prepare(`
    INSERT INTO work_items
      (id,goal_id,title,description,type,status,workspace_path,repo_path,customer,success_criteria,resume_count,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)
  `).run(
    id,
    input.goalId || null,
    input.title.trim(),
    input.description.trim(),
    input.type || "digital-work",
    "planned",
    workspacePath,
    input.repoPath || null,
    input.customer || null,
    input.successCriteria || null,
    now(),
    now(),
  );

  const manifest = [
    "# RITTY WORK",
    "",
    `ID: ${id}`,
    `Title: ${input.title.trim()}`,
    `Type: ${input.type || "digital-work"}`,
    `Customer: ${input.customer || "not specified"}`,
    "",
    "## Objective",
    input.description.trim(),
    "",
    "## Success Criteria",
    input.successCriteria?.trim() || "Deliver the requested result, verify it, and record all artifacts.",
    "",
    "## Execution Policy",
    "- Work only inside the declared workspace/repository.",
    "- Test before declaring complete.",
    "- Record checkpoints after meaningful progress.",
    "- Preserve enough state to resume after interruption.",
    "- Never perform real financial operations.",
    "",
    "## Status",
    "planned",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(workspacePath, "WORK.md"), manifest, "utf8");
  return readWorkRow(raw, id)!;
}

export function ensureWorkForGoal(
  db: AutomatonDatabase | import("better-sqlite3").Database,
  goalId: string,
  title: string,
  description: string,
  workspacePath?: string,
): WorkItem {
  ensureWorkSchema(db);
  const raw = rawOf(db);
  const existing = raw.prepare(
    "SELECT id FROM work_items WHERE goal_id=? ORDER BY updated_at DESC LIMIT 1",
  ).get(goalId) as { id: string } | undefined;
  if (existing) return readWorkRow(raw, existing.id)!;
  return createWork(db, {
    goalId,
    title,
    description,
    workspacePath,
  });
}

export function startWork(db: AutomatonDatabase | import("better-sqlite3").Database, workId: string, note = "Work started"): WorkItem {
  ensureWorkSchema(db);
  const raw = rawOf(db);
  const id = normalizeWorkId(workId);
  const existing = readWorkRow(raw, id);
  if (!existing) throw new Error(`Work not found: ${id}`);
  const timestamp = now();
  raw.prepare(
    "UPDATE work_items SET status='in_progress',resume_count=resume_count+1,started_at=COALESCE(started_at,?),updated_at=? WHERE id=?"
  ).run(timestamp, timestamp, id);
  checkpointWork(db, id, "start", "in_progress", note);
  updateManifest(existing.workspacePath, "in_progress", note);
  return readWorkRow(raw, id)!;
}

export function checkpointWork(
  db: AutomatonDatabase | import("better-sqlite3").Database,
  workId: string,
  stage: string,
  status: string,
  note: string,
  payload?: Record<string, unknown>,
): void {
  ensureWorkSchema(db);
  const raw = rawOf(db);
  const id = ulid();
  const ts = now();
  raw.prepare(
    "INSERT INTO work_checkpoints (id,work_id,stage,status,note,payload,created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(id, workId, stage, status, note, payload ? JSON.stringify(payload) : null, ts);
  raw.prepare(
    "UPDATE work_items SET status=?,last_checkpoint_id=?,updated_at=? WHERE id=?"
  ).run(status === "in_progress" ? "in_progress" : status, id, ts, workId);
  const work = readWorkRow(raw, workId);
  if (work) updateManifest(work.workspacePath, work.status, note);
}

export function recordWorkArtifact(
  db: AutomatonDatabase | import("better-sqlite3").Database,
  workId: string,
  artifactPath: string,
  kind = "deliverable",
  label?: string,
  metadata?: Record<string, unknown>,
): void {
  ensureWorkSchema(db);
  const raw = rawOf(db);
  raw.prepare(
    "INSERT INTO work_artifacts (id,work_id,path,kind,label,metadata,created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(
    ulid(),
    workId,
    artifactPath,
    kind,
    label || null,
    metadata ? JSON.stringify(metadata) : null,
    now(),
  );
}

export function recordWorkTest(
  db: AutomatonDatabase | import("better-sqlite3").Database,
  args: {
    workId: string;
    command: string;
    cwd?: string;
    status: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    durationMs?: number;
  },
): void {
  ensureWorkSchema(db);
  const raw = rawOf(db);
  raw.prepare(
    "INSERT INTO work_tests (id,work_id,command,cwd,status,exit_code,stdout,stderr,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(
    ulid(),
    args.workId,
    args.command,
    args.cwd || null,
    args.status,
    args.exitCode ?? null,
    (args.stdout || "").slice(0, 12000),
    (args.stderr || "").slice(0, 12000),
    Math.max(0, Math.floor(args.durationMs || 0)),
    now(),
  );
}

export function completeWork(
  db: AutomatonDatabase | import("better-sqlite3").Database,
  workId: string,
  success: boolean,
  summary: string,
): WorkItem {
  ensureWorkSchema(db);
  const raw = rawOf(db);
  const id = normalizeWorkId(workId);
  const timestamp = now();
  const status: WorkStatus = success ? "completed" : "failed";
  raw.prepare(
    "UPDATE work_items SET status=?,summary=?,completed_at=?,updated_at=? WHERE id=?"
  ).run(status, summary.slice(0, 12000), timestamp, timestamp, id);
  checkpointWork(db, id, success ? "complete" : "failure", status, summary);
  const work = readWorkRow(raw, id)!;
  updateManifest(work.workspacePath, status, summary);
  return work;
}

export function recoverInterruptedWorks(db: AutomatonDatabase | import("better-sqlite3").Database): number {
  ensureWorkSchema(db);
  const raw = rawOf(db);
  const rows = raw.prepare("SELECT id,workspace_path FROM work_items WHERE status='in_progress'").all() as any[];
  const timestamp = now();
  for (const row of rows) {
    raw.prepare("UPDATE work_items SET status='interrupted',updated_at=? WHERE id=?").run(timestamp, row.id);
    raw.prepare(
      "INSERT INTO work_checkpoints (id,work_id,stage,status,note,created_at) VALUES (?,?,?,?,?,?)"
    ).run(ulid(), row.id, "recovery", "interrupted", "Runtime restarted before this work was completed. Resume from the last checkpoint.", timestamp);
    try {
      updateManifest(row.workspace_path, "interrupted", "Runtime restarted before completion. Resume from the last checkpoint.");
    } catch {}
  }
  return rows.length;
}

export function getWorkArtifacts(db: AutomatonDatabase | import("better-sqlite3").Database, workId: string): Array<Record<string, unknown>> {
  ensureWorkSchema(db);
  return rawOf(db).prepare(
    "SELECT id,path,kind,label,metadata,created_at AS createdAt FROM work_artifacts WHERE work_id=? ORDER BY created_at DESC"
  ).all(workId) as Array<Record<string, unknown>>;
}

export function getWorkTests(db: AutomatonDatabase | import("better-sqlite3").Database, workId: string): Array<Record<string, unknown>> {
  ensureWorkSchema(db);
  return rawOf(db).prepare(
    "SELECT id,command,cwd,status,exit_code AS exitCode,stdout,stderr,duration_ms AS durationMs,created_at AS createdAt FROM work_tests WHERE work_id=? ORDER BY created_at DESC"
  ).all(workId) as Array<Record<string, unknown>>;
}

export async function executeWorkBundle(
  db: AutomatonDatabase | import("better-sqlite3").Database,
  workId: string,
  input: {
    files: Array<{ path: string; content: string }>;
    testCommand: string;
    artifacts?: string[];
    summary?: string;
    cwd?: string;
  },
  runner?: ConwayClient,
): Promise<{
  workId: string;
  workspacePath: string;
  test: string;
  artifacts: string[];
  completed: boolean;
  summary: string;
}> {
  ensureWorkSchema(db);
  const work = getWork(db, workId);
  if (!work) throw new Error(`Work not found: ${workId}`);

  let active = work;
  if (active.status !== "in_progress") {
    active = startWork(db, active.id, "Work bundle execution started/resumed");
  }

  const workspace = path.resolve(active.workspacePath);
  for (const file of input.files) {
    const relative = String(file.path || "").replace(/^\/+/, "");
    const destination = path.resolve(workspace, relative);
    if (destination !== workspace && !destination.startsWith(workspace + path.sep)) {
      throw new Error(`Artifact/file path escapes work workspace: ${file.path}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, String(file.content ?? ""), "utf8");
  }

  checkpointWork(
    db,
    active.id,
    "implementation",
    "in_progress",
    `Wrote ${input.files.length} file(s) into the durable workspace.`,
    { files: input.files.map((f) => f.path) },
  );

  const test = await runTrackedTest(
    db,
    active.id,
    input.testCommand,
    path.resolve(input.cwd || workspace),
    120000,
    runner,
  );

  const testPassed = test.includes("status=passed");
  if (!testPassed) {
    const summary = input.summary || "Validation failed; work remains blocked for diagnosis/correction.";
    checkpointWork(db, active.id, "validation", "blocked", summary, { test });
    return {
      workId: active.id,
      workspacePath: workspace,
      test,
      artifacts: [],
      completed: false,
      summary,
    };
  }

  const recordedArtifacts = [];
  for (const artifact of input.artifacts || []) {
    const relative = String(artifact).replace(/^\/+/, "");
    const destination = path.resolve(workspace, relative);
    if (destination !== workspace && !destination.startsWith(workspace + path.sep)) {
      throw new Error(`Artifact path escapes work workspace: ${artifact}`);
    }
    if (!fs.existsSync(destination)) {
      throw new Error(`Declared artifact does not exist: ${artifact}`);
    }
    recordWorkArtifact(db, active.id, destination, "deliverable", path.basename(destination));
    recordedArtifacts.push(destination);
  }

  checkpointWork(
    db,
    active.id,
    "delivery",
    "in_progress",
    `Validation passed and ${recordedArtifacts.length} artifact(s) registered.`,
    { artifacts: recordedArtifacts },
  );

  const summary = input.summary || "Work implemented, validated, artifacts recorded, and completed.";
  completeWork(db, active.id, true, summary);
  return {
    workId: active.id,
    workspacePath: workspace,
    test,
    artifacts: recordedArtifacts,
    completed: true,
    summary,
  };
}

export function getWorkResumeContext(db: AutomatonDatabase | import("better-sqlite3").Database, workId: string): string {
  ensureWorkSchema(db);
  const raw = rawOf(db);
  const work = readWorkRow(raw, normalizeWorkId(workId));
  if (!work) return `Work not found: ${workId}`;
  const checkpoints = raw.prepare(
    "SELECT stage,status,note,created_at AS createdAt FROM work_checkpoints WHERE work_id=? ORDER BY created_at DESC LIMIT 12"
  ).all(work.id) as any[];
  const artifacts = getWorkArtifacts(db, work.id);
  const tests = getWorkTests(db, work.id);
  return JSON.stringify({
    work,
    resumeInstruction: "Continue from the latest successful checkpoint. Do not restart completed work unless validation proves it is necessary.",
    checkpoints,
    artifacts,
    recentTests: tests.slice(0, 8),
  }, null, 2);
}

export async function runTrackedTest(
  db: AutomatonDatabase | import("better-sqlite3").Database,
  workId: string,
  command: string,
  cwd: string,
  timeoutMs = 120000,
  runner?: ConwayClient,
): Promise<string> {
  ensureWorkSchema(db);
  const started = Date.now();
  const result = runner
    ? await runner.exec(`cd ${shellQuote(cwd)} && ${command}`, timeoutMs)
    : await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        execCb(command, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
          resolve({
            stdout: stdout || "",
            stderr: stderr || (error ? String(error.message || "") : ""),
            exitCode: error?.code && typeof error.code === "number" ? error.code : error ? 1 : 0,
          });
        });
      });
  const status = result.exitCode === 0 ? "passed" : "failed";
  recordWorkTest(db, {
    workId,
    command,
    cwd,
    status,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - started,
  });
  checkpointWork(
    db,
    workId,
    "test",
    result.exitCode === 0 ? "in_progress" : "blocked",
    result.exitCode === 0
      ? `Test passed: ${command}`
      : `Test failed (exit ${result.exitCode}): ${command}`,
  );
  return `status=${status}\nexit_code=${result.exitCode}\nstdout:\n${result.stdout.slice(0,12000)}\nstderr:\n${result.stderr.slice(0,12000)}`;
}

export async function publishWork(
  db: AutomatonDatabase | import("better-sqlite3").Database,
  workId: string,
  target: "vercel" | "railway" | "git",
  projectPath: string,
  approved: boolean,
  runner?: ConwayClient,
): Promise<string> {
  ensureWorkSchema(db);
  if (!approved) {
    return `PUBLISH_PENDING_APPROVAL: target=${target}, project=${projectPath}. Set approved=true after confirming external publication.`;
  }

  const commands: Record<string, string> = {
    vercel: "if command -v vercel >/dev/null 2>&1; then vercel --prod --yes; elif command -v npx >/dev/null 2>&1; then npx vercel --prod --yes; else echo 'vercel CLI not installed' >&2; exit 127; fi",
    railway: "if command -v railway >/dev/null 2>&1; then railway up --detach; elif command -v npx >/dev/null 2>&1; then npx @railway/cli up --detach; else echo 'railway CLI not installed' >&2; exit 127; fi",
    git: "git add -A && git commit -m " + JSON.stringify(`RITTY deliver ${workId}`) + " && git push",
  };
  const command = commands[target];
  const cwd = path.resolve(projectPath);
  const started = Date.now();
  const result = runner
    ? await runner.exec(`cd ${shellQuote(cwd)} && ${command}`, 180000)
    : await new Promise<{stdout:string;stderr:string;exitCode:number}>((resolve) => {
        execCb(command, { cwd, timeout: 180000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
          resolve({ stdout: stdout || "", stderr: stderr || "", exitCode: error ? 1 : 0 });
        });
      });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 16000);
  const status = result.exitCode === 0 ? "published" : "failed";
  const urlMatch = output.match(/https?:\/\/[^\s]+/);
  rawOf(db).prepare(
    "INSERT INTO work_publish_runs (id,work_id,target,status,url,output,created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(ulid(), workId, target, status, urlMatch?.[0] || null, output, now());
  checkpointWork(
    db,
    workId,
    "publish",
    status === "published" ? "in_progress" : "blocked",
    status === "published" ? `Published to ${target}` : `Publish to ${target} failed`,
    { output: output.slice(0, 4000), durationMs: Date.now() - started, url: urlMatch?.[0] || null },
  );
  return `status=${status}\ntarget=${target}\nurl=${urlMatch?.[0] || "not detected"}\noutput:\n${output}`;
}

function updateManifest(workspacePath: string, status: string, note: string): void {
  try {
    const manifest = path.join(workspacePath, "WORK.md");
    if (!fs.existsSync(manifest)) return;
    const original = fs.readFileSync(manifest, "utf8");
    const updated = original.replace(/## Status\n[\s\S]*$/m, `## Status\n${status}\n\n## Latest Checkpoint\n${now()}\n${note.slice(0, 1200)}\n`);
    fs.writeFileSync(manifest, updated, "utf8");
  } catch {}
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function ensureWorkWorkspace(work: WorkItem): AgentWorkspace {
  return new AgentWorkspace(work.id, work.workspacePath);
}
