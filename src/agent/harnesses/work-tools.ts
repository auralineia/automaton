import { getWork, createWork, startWork, checkpointWork, recordWorkArtifact, completeWork, getWorkResumeContext, runTrackedTest, publishWork, ensureWorkSchema } from "../../orchestration/work-engine.js";
import type { HarnessContext, HarnessTool } from "../harness-types.js";

function resolveWorkId(context: HarnessContext, explicit?: string): string | null {
  if (explicit) return explicit;
  ensureWorkSchema(context.db);

  const goalRow = context.db.prepare(
    "SELECT id FROM work_items WHERE goal_id=? ORDER BY updated_at DESC LIMIT 1",
  ).get(context.goalId) as { id?: string } | undefined;
  if (goalRow?.id) return goalRow.id;

  // Creator messages can arrive without a goal id. In that case keep the
  // durable workflow attached to the most recently updated unfinished work
  // item instead of forcing the model to rediscover an opaque ULID.
  if (context.inputSource === "creator") {
    const latest = context.db.prepare(
      "SELECT id FROM work_items WHERE status NOT IN ('completed','failed') ORDER BY updated_at DESC LIMIT 1",
    ).get() as { id?: string } | undefined;
    return latest?.id || null;
  }

  return null;
}

export function createWorkHarnessTools(context: HarnessContext): HarnessTool[] {
  return [
    {
      name: "work_status",
      description: "Inspect the durable work item, latest checkpoint, artifacts and recent tests. Use this before resuming interrupted work.",
      parameters: {
        type: "object",
        properties: { work_id: { type: "string", description: "Optional work ID; defaults to the work linked to this goal." } },
      },
      execute: async (args) => {
        const id = resolveWorkId(context, typeof args.work_id === "string" ? args.work_id : undefined);
        if (!id) return "No work item exists for this goal yet. Create one with work_create.";
        const work = getWork(context.db, id);
        return work ? JSON.stringify(work, null, 2) : `Work not found: ${id}`;
      },
    },
    {
      name: "work_create",
      description: "Create a durable work item with a persistent workspace and WORK.md manifest. Do this before starting a substantial deliverable.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          type: { type: "string" },
          repo_path: { type: "string" },
          customer: { type: "string" },
          success_criteria: { type: "string" },
        },
        required: ["title", "description"],
      },
      execute: async (args) => {
        const work = createWork(context.db, {
          title: String(args.title || ""),
          description: String(args.description || ""),
          type: typeof args.type === "string" ? args.type : "digital-work",
          repoPath: typeof args.repo_path === "string" ? args.repo_path : undefined,
          customer: typeof args.customer === "string" ? args.customer : undefined,
          successCriteria: typeof args.success_criteria === "string" ? args.success_criteria : undefined,
          goalId: context.goalId,
        });
        return `WORK_CREATED ${work.id}\nworkspace=${work.workspacePath}`;
      },
    },
    {
      name: "work_start",
      description: "Mark work as in progress/resumed. Call after inspecting the latest checkpoint.",
      parameters: {
        type: "object",
        properties: { work_id: { type: "string" }, note: { type: "string" } },
      },
      execute: async (args) => {
        const id = resolveWorkId(context, typeof args.work_id === "string" ? args.work_id : undefined);
        if (!id) return "No work item found for this goal.";
        const work = startWork(context.db, id, typeof args.note === "string" ? args.note : "Work resumed");
        return `WORK_STARTED ${work.id} status=${work.status} resumeCount=${work.resumeCount}`;
      },
    },
    {
      name: "work_resume",
      description: "Load the full resume context from the last durable checkpoint. Continue from the last successful point; do not restart completed work.",
      parameters: {
        type: "object",
        properties: { work_id: { type: "string" } },
      },
      execute: async (args) => {
        const id = resolveWorkId(context, typeof args.work_id === "string" ? args.work_id : undefined);
        if (!id) return "No work item found for this goal.";
        return getWorkResumeContext(context.db, id);
      },
    },
    {
      name: "work_checkpoint",
      description: "Persist a meaningful milestone, decision, blocker, diagnosis or next action so the job can resume after interruption.",
      parameters: {
        type: "object",
        properties: {
          work_id: { type: "string" },
          stage: { type: "string" },
          status: { type: "string", description: "in_progress, blocked, paused, interrupted, completed or failed" },
          note: { type: "string" },
          payload: { type: "object" },
        },
        required: ["stage", "status", "note"],
      },
      execute: async (args) => {
        const id = resolveWorkId(context, typeof args.work_id === "string" ? args.work_id : undefined);
        if (!id) return "No work item found for this goal.";
        checkpointWork(context.db, id, String(args.stage), String(args.status), String(args.note), (args.payload && typeof args.payload === "object") ? args.payload as Record<string, unknown> : undefined);
        return `CHECKPOINT_SAVED ${id} stage=${args.stage} status=${args.status}`;
      },
    },
    {
      name: "work_artifact",
      description: "Register a produced file/folder/URL as a durable deliverable artifact for the current work item.",
      parameters: {
        type: "object",
        properties: {
          work_id: { type: "string" },
          path: { type: "string" },
          kind: { type: "string" },
          label: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["path"],
      },
      execute: async (args) => {
        const id = resolveWorkId(context, typeof args.work_id === "string" ? args.work_id : undefined);
        if (!id) return "No work item found for this goal.";
        recordWorkArtifact(context.db, id, String(args.path), typeof args.kind === "string" ? args.kind : "deliverable", typeof args.label === "string" ? args.label : undefined, (args.metadata && typeof args.metadata === "object") ? args.metadata as Record<string, unknown> : undefined);
        return `ARTIFACT_RECORDED ${id}: ${args.path}`;
      },
    },
    {
      name: "work_test",
      description: "Run a verification/build/test command and persist its exact exit code, output and duration into the work record.",
      parameters: {
        type: "object",
        properties: {
          work_id: { type: "string" },
          command: { type: "string" },
          cwd: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["command"],
      },
      execute: async (args) => {
        const id = resolveWorkId(context, typeof args.work_id === "string" ? args.work_id : undefined);
        if (!id) return "No work item found for this goal.";
        const cwd = typeof args.cwd === "string" ? args.cwd : context.workspaceRoot;
        return runTrackedTest(context.db, id, String(args.command), cwd, typeof args.timeout_ms === "number" ? args.timeout_ms : 120000, context.conway);
      },
    },
    {
      name: "work_publish",
      description: "Publish the completed work to Vercel, Railway, or git. Production publication requires approved=true; preview/test work can be done before that.",
      parameters: {
        type: "object",
        properties: {
          work_id: { type: "string" },
          target: { type: "string", enum: ["vercel", "railway", "git"] },
          project_path: { type: "string" },
          approved: { type: "boolean" },
        },
        required: ["target", "project_path", "approved"],
      },
      execute: async (args) => {
        const id = resolveWorkId(context, typeof args.work_id === "string" ? args.work_id : undefined);
        if (!id) return "No work item found for this goal.";
        return publishWork(context.db, id, args.target as "vercel" | "railway" | "git", String(args.project_path), args.approved === true, context.conway);
      },
    },
    {
      name: "work_complete",
      description: "Mark the durable work item complete or failed with a consolidated delivery summary. Use only after tests/validation.",
      parameters: {
        type: "object",
        properties: { work_id: { type: "string" }, success: { type: "boolean" }, summary: { type: "string" } },
        required: ["success", "summary"],
      },
      execute: async (args) => {
        const id = resolveWorkId(context, typeof args.work_id === "string" ? args.work_id : undefined);
        if (!id) return "No work item found for this goal.";
        const work = completeWork(context.db, id, args.success !== false, String(args.summary));
        return `WORK_${work.status.toUpperCase()} ${work.id}`;
      },
    },
  ];
}
