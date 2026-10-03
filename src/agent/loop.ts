/**
 * The Agent Loop
 *
 * The core ReAct loop: Think -> Act -> Observe -> Persist.
 * This is the automaton's consciousness. When this runs, it is alive.
 */

import path from "node:path";
import type {
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  InferenceClient,
  AgentState,
  AgentTurn,
  ToolCallResult,
  FinancialState,
  ToolContext,
  AutomatonTool,
  Skill,
  SocialClientInterface,
  SpendTrackerInterface,
  InputSource,
  ModelStrategyConfig,
} from "../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import type { PolicyEngine } from "./policy-engine.js";
import { buildSystemPrompt, buildWakeupPrompt } from "./system-prompt.js";
import { buildContextMessages, trimContext } from "./context.js";
import {
  createBuiltinTools,
  loadInstalledTools,
  toolsToInferenceFormat,
  executeTool,
} from "./tools.js";
import { sanitizeInput } from "./injection-defense.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getUsdcBalance } from "../conway/x402.js";
import {
  claimInboxMessages,
  markInboxProcessed,
  markInboxFailed,
  resetInboxToReceived,
  consumeNextWakeEvent,
  getActiveGoals,
} from "../state/database.js";
import type { InboxMessageRow } from "../state/database.js";
import { ulid } from "ulid";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { InferenceRouter } from "../inference/router.js";
import { MemoryRetriever } from "../memory/retrieval.js";
import { MemoryIngestionPipeline } from "../memory/ingestion.js";
import { DEFAULT_MEMORY_BUDGET } from "../types.js";
import { formatMemoryBlock } from "./context.js";
import { createLogger } from "../observability/logger.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import { PlanModeController } from "../orchestration/plan-mode.js";
import { generateTodoMd, injectTodoContext } from "../orchestration/attention.js";
import { ColonyMessaging, LocalDBTransport } from "../orchestration/messaging.js";
import { LocalWorkerPool } from "../orchestration/local-worker.js";
import { SimpleAgentTracker, SimpleFundingProtocol } from "../orchestration/simple-tracker.js";
import { HarnessRegistry } from "./harness-registry.js";
import { createWorkerInferenceBridge } from "./worker-inference-bridge.js";
import { ProviderRegistry } from "../inference/provider-registry.js";
import { UnifiedInferenceClient } from "../inference/inference-client.js";
import { isIdleOnlyTool } from "./idle-only-tools.js";

const logger = createLogger("loop");
const MAX_TOOL_CALLS_PER_TURN = 10;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_REPETITIVE_TURNS = 3;

/**
 * Sovereign mode wraps every underlying tool call in the generic
 * "invoke_tool" function. Loop/idle/sleep detection must reason about the
 * actual target tool, not the wrapper name.
 */
function getObservedToolName(call: ToolCallResult): string {
  if (call.name !== "invoke_tool") return call.name;

  const args = call.arguments;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const target = (args as Record<string, unknown>).tool_name;
    if (typeof target === "string" && target.trim()) {
      return target.trim();
    }
  }

  return call.name;
}

export interface AgentLoopOptions {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  inference: InferenceClient;
  social?: SocialClientInterface;
  skills?: Skill[];
  policyEngine?: PolicyEngine;
  spendTracker?: SpendTrackerInterface;
  onStateChange?: (state: AgentState) => void;
  onTurnComplete?: (turn: AgentTurn) => void;
  ollamaBaseUrl?: string;
}

/**
 * Run the agent loop. This is the main execution path.
 * Returns when the agent decides to sleep or when compute runs out.
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<void> {
  const { identity, config, db, conway, inference, social, skills, policyEngine, spendTracker, onStateChange, onTurnComplete, ollamaBaseUrl } =
    options;

  const builtinTools = createBuiltinTools(identity.sandboxId);
  const installedTools = loadInstalledTools(db);
  const tools = [...builtinTools, ...installedTools];
  const toolContext: ToolContext = {
    identity,
    config,
    db,
    conway,
    inference,
    social,
  };

  // Initialize inference router (Phase 2.3)
  const modelStrategyConfig: ModelStrategyConfig = {
    ...DEFAULT_MODEL_STRATEGY_CONFIG,
    ...(config.modelStrategy ?? {}),
  };
  const modelRegistry = new ModelRegistry(db.raw);
  modelRegistry.initialize();

  // Discover Ollama models if configured
  if (ollamaBaseUrl) {
    const { discoverOllamaModels } = await import("../ollama/discover.js");
    await discoverOllamaModels(ollamaBaseUrl, db.raw);
  }
  const budgetTracker = new InferenceBudgetTracker(db.raw, modelStrategyConfig);
  const inferenceRouter = new InferenceRouter(db.raw, modelRegistry, budgetTracker);

  // Optional orchestration bootstrap (requires V9 goals/task tables)
  let planModeController: PlanModeController | undefined;
  let orchestrator: Orchestrator | undefined;
  let workerPool: LocalWorkerPool | undefined;

  if (hasTable(db.raw, "goals")) {
    try {
      planModeController = new PlanModeController(db.raw);

      // Bridge automaton config API keys to env vars for the provider registry.
      // The registry reads keys from process.env; the automaton config may have
      // them from config.json or Conway provisioning.
      if (config.openaiApiKey && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = config.openaiApiKey;
      }
      if (config.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
      }
      // Conway Compute API is OpenAI-compatible. Use it as fallback when no
      // direct OpenAI key is available. The conwayApiKey is always present
      // (required for sandbox operations), so this ensures the orchestrator
      // can always make inference calls.
      if (config.conwayApiKey && !process.env.CONWAY_API_KEY) {
        process.env.CONWAY_API_KEY = config.conwayApiKey;
      }
      // If no OpenAI key is set but Conway key is available, use Conway as
      // the OpenAI provider (Conway Compute is OpenAI API-compatible).
      if (!process.env.OPENAI_API_KEY && config.conwayApiKey) {
        process.env.OPENAI_API_KEY = config.conwayApiKey;
        process.env.OPENAI_BASE_URL = `${config.conwayApiUrl}/v1`;
      }

      const providersPath = path.join(
        process.env.HOME || process.cwd(),
        ".automaton",
        "inference-providers.json",
      );
      const registry = ProviderRegistry.fromConfig(providersPath);

      // If OPENAI_BASE_URL was set (Conway fallback), update the default
      // provider's baseUrl so the OpenAI client points to Conway Compute.
      if (process.env.OPENAI_BASE_URL) {
        registry.overrideBaseUrl("openai", process.env.OPENAI_BASE_URL);
      }

      const unifiedInference = new UnifiedInferenceClient(registry);
      const agentTracker = new SimpleAgentTracker(db);
      const funding = new SimpleFundingProtocol(conway, identity, db);
      const messaging = new ColonyMessaging(
        new LocalDBTransport(db),
        db,
      );

      const harnessRegistry = new HarnessRegistry();

      // Adapter: local workers use the unified inference path so planner-backed
      // harnesses can preserve tier + responseFormat contracts.
      const workerInference = createWorkerInferenceBridge(unifiedInference);

      // Local worker pool: runs inference-driven agents in-process
      // as async tasks. Falls back from Conway sandbox spawning.
      const initializedWorkerPool = new LocalWorkerPool({
        db: db.raw,
        inference: workerInference,
        conway,
        harnessRegistry,
        identity,
        config,
        allowedEditRoot: process.cwd(),
        tools,
        toolContext,
        policyEngine,
        spendTracker,
      });
      workerPool = initializedWorkerPool;

      orchestrator = new Orchestrator({
        db: db.raw,
        agentTracker,
        funding,
        messaging,
        inference: unifiedInference,
        identity,
        isWorkerAlive: (address: string) => {
          if (address.startsWith("local://")) {
            return initializedWorkerPool.hasWorker(address);
          }
          // Remote workers: check children table
          const child = db.raw.prepare(
            "SELECT status FROM children WHERE sandbox_id = ? OR address = ?",
          ).get(address, address) as { status: string } | undefined;
          if (!child) return false;
          return !["failed", "dead", "cleaned_up"].includes(child.status);
        },
        config: {
          ...config,
          spawnAgent: async (task: any) => {
            // Try Conway sandbox spawn first (production)
            try {
              const { generateGenesisConfig } = await import("../replication/genesis.js");
              const { spawnChild } = await import("../replication/spawn.js");
              const { ChildLifecycle } = await import("../replication/lifecycle.js");

              const role = task.agentRole ?? "generalist";
              const genesis = generateGenesisConfig(identity, config, {
                name: `worker-${role}-${Date.now().toString(36)}`,
                specialization: `${role}: ${task.title}`,
              });

              const lifecycle = new ChildLifecycle(db.raw);
              const child = await spawnChild(conway, identity, db, genesis, lifecycle);

              return {
                address: child.address,
                name: child.name,
                sandboxId: child.sandboxId,
              };
            } catch (sandboxError: any) {
              // If the error is a 402 (insufficient credits), attempt topup and retry once
              const is402 = sandboxError?.status === 402 ||
                sandboxError?.message?.includes("INSUFFICIENT_CREDITS");

              if (is402) {
                const SANDBOX_TOPUP_COOLDOWN_MS = 60_000;
                const lastAttempt = db.getKV("last_sandbox_topup_attempt");
                const cooldownExpired = !lastAttempt ||
                  Date.now() - new Date(lastAttempt).getTime() >= SANDBOX_TOPUP_COOLDOWN_MS;

                if (cooldownExpired) {
                  db.setKV("last_sandbox_topup_attempt", new Date().toISOString());
                  try {
                    const { topupForSandbox } = await import("../conway/topup.js");
                    const topupResult = await topupForSandbox({
                      apiUrl: config.conwayApiUrl,
                      account: identity.account,
                      error: sandboxError,
                      chainType: config.chainType || identity.chainType || "evm",
                    });

                    if (topupResult?.success) {
                      logger.info(`Sandbox topup succeeded ($${topupResult.amountUsd}), retrying spawn`, {
                        taskId: task.id,
                      });
                      // Retry spawn once after successful topup
                      try {
                        const { generateGenesisConfig: genGenesis } = await import("../replication/genesis.js");
                        const { spawnChild: retrySpawn } = await import("../replication/spawn.js");
                        const { ChildLifecycle: RetryLifecycle } = await import("../replication/lifecycle.js");

                        const retryRole = task.agentRole ?? "generalist";
                        const retryGenesis = genGenesis(identity, config, {
                          name: `worker-${retryRole}-${Date.now().toString(36)}`,
                          specialization: `${retryRole}: ${task.title}`,
                        });
                        const retryLifecycle = new RetryLifecycle(db.raw);
                        const child = await retrySpawn(conway, identity, db, retryGenesis, retryLifecycle);
                        return {
                          address: child.address,
                          name: child.name,
                          sandboxId: child.sandboxId,
                        };
                      } catch (retryError) {
                        logger.warn("Spawn retry after topup failed", {
                          taskId: task.id,
                          error: retryError instanceof Error ? retryError.message : String(retryError),
                        });
                      }
                    }
                  } catch (topupError) {
                    logger.warn("Sandbox topup attempt failed", {
                      taskId: task.id,
                      error: topupError instanceof Error ? topupError.message : String(topupError),
                    });
                  }
                }
              }

              // Conway sandbox unavailable — fall back to local worker
              logger.info("Conway sandbox unavailable, spawning local worker", {
                taskId: task.id,
                error: sandboxError instanceof Error ? sandboxError.message : String(sandboxError),
              });

              try {
                const spawned = initializedWorkerPool.spawn(task);
                return spawned;
              } catch (localError) {
                logger.warn("Failed to spawn local worker", {
                  taskId: task.id,
                  error: localError instanceof Error ? localError.message : String(localError),
                });
                return null;
              }
            }
          },
        },
      });
    } catch (error) {
      logger.warn(
        `Orchestrator initialization failed, continuing without orchestration: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      planModeController = undefined;
      orchestrator = undefined;
    }
  }

  // Recover creator/inbox messages that were left in_progress by a previous
  // container/process restart. This runtime uses a single SQLite DB, so at the
  // start of a fresh loop there cannot be another claimant still executing.
  // Keeping these rows in_progress would make the dashboard show "processing"
  // forever and the message would never be picked up again.
  const recoveredInbox = db.raw.prepare(
    `UPDATE inbox_messages
     SET status = CASE WHEN retry_count < max_retries THEN 'received' ELSE 'failed' END
     WHERE status = 'in_progress'`,
  ).run();
  if (recoveredInbox.changes > 0) {
    logger.warn(`[INBOX] Recovered ${recoveredInbox.changes} message(s) left in_progress by a previous runtime instance.`);
  }

  // A parent-assigned task cannot survive a process restart as an active
  // execution. Release stale self-assigned tasks so future goals are picked
  // up by a real worker instead of remaining "assigned" forever. Financial
  // or wallet-related goals are deliberately left untouched.
  try {
    const now = Date.now();
    const selfTasks = db.raw.prepare(
      `SELECT t.id, t.started_at, t.created_at, t.timeout_ms, g.title, g.description
       FROM task_graph t
       JOIN goals g ON g.id = t.goal_id
       WHERE t.assigned_to = ?
         AND t.status IN ('assigned', 'running')`,
    ).all(identity.address) as Array<{
      id: string;
      started_at: string | null;
      created_at: string;
      timeout_ms: number;
      title: string;
      description: string;
    }>;

    for (const task of selfTasks) {
      const goalText = `${task.title} ${task.description}`.toLowerCase();
      const financialLike =
        /(wallet|transfer|trading|trade|investment|invest|payment|money|finance|financial|crypto|bitcoin|usdc|currency|exchange|payment)/i.test(goalText);
      if (financialLike) continue;

      const origin = task.started_at ?? task.created_at;
      const ageMs = Math.max(0, now - new Date(origin).getTime());
      const timeoutMs = Math.max(60_000, Number(task.timeout_ms) || 300_000);
      if (ageMs >= Math.max(120_000, timeoutMs)) {
        db.raw.prepare(
          `UPDATE task_graph
           SET status = 'pending', assigned_to = NULL, started_at = NULL
           WHERE id = ?`,
        ).run(task.id);
        db.raw.prepare("DELETE FROM kv WHERE key = ?").run(`orchestrator.task_lease.${task.id}`);
        logger.warn("[ORCHESTRATION] Released stale self-assigned task after runtime restart.", {
          taskId: task.id,
          ageMs,
          timeoutMs,
        });
      }
    }
  } catch (error) {
    logger.warn(
      `[ORCHESTRATION] Startup self-assignment recovery skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Recover the latest substantial creator request after a restart.
  if (!db.getKV("creator_task_active")) {
    try {
      const row = db.raw.prepare(
        "SELECT input,timestamp FROM turns WHERE input_source = 'creator' AND input IS NOT NULL ORDER BY timestamp DESC LIMIT 1",
      ).get() as { input?: string; timestamp?: string } | undefined;
      const input = String(row?.input ?? "").trim();
      const age = row?.timestamp ? Date.now() - new Date(row.timestamp).getTime() : Infinity;
      if (input.length > 100 && age >= 0 && age < 24 * 60 * 60 * 1000) {
        db.setKV("creator_task_active", input);
        db.deleteKV("sleep_until");
        logger.info("[CREATOR] Recovered latest creator request after restart.");
      }
    } catch {}
  }

  // Set start time
  if (!db.getKV("start_time")) {
    db.setKV("start_time", new Date().toISOString());
  }

  let consecutiveErrors = 0;
  let running = true;
  let lastToolPatterns: string[] = [];
  let loopWarningPattern: string | null = null;
  let idleToolTurns = 0;
  // blockedGoalTurns removed — replaced by immediate sleep + exponential backoff

  // Drain any stale wake events from before this loop started,
  // so they don't re-wake the agent after its first sleep.
  let drained = 0;
  while (consumeNextWakeEvent(db.raw)) drained++;

  // Clear any stale sleep_until from a previous session so the agent
  // doesn't immediately go back to sleep on startup.
  db.deleteKV("sleep_until");

  // Transition to waking state
  db.setAgentState("waking");
  onStateChange?.("waking");

  // Get financial state
  let financial = await getFinancialState(conway, identity.address, db, config.chainType || identity.chainType || "evm");

  // Check if this is the first run
  const isFirstRun = db.getTurnCount() === 0;

  // Build wakeup prompt
  const wakeupInput = buildWakeupPrompt({
    identity,
    config,
    financial,
    db,
  });

  // Transition to running
  db.setAgentState("running");
  onStateChange?.("running");

  log(config, `[WAKE UP] ${config.name} is alive. Credits: ${(financial.creditsCents / 100).toFixed(2)}`);

  // One-time non-financial smoke test of the real sovereign execution path.
  // Verify file creation and shell execution without assuming Node/Python exist
  // in the remote command container. No goals or financial systems are touched.
  if (db.getKV("ritty_execution_smoke_v1") !== "passed") {
    try {
      const smoke = await conway.exec(
        "mkdir -p /root/workspace/ritty-smoke && " +
        "printf '%s' 'RITTY_EXECUTION_OK' > /root/workspace/ritty-smoke/result.txt && " +
        "test \"$(cat /root/workspace/ritty-smoke/result.txt)\" = 'RITTY_EXECUTION_OK' && " +
        "echo RITTY_EXECUTION_OK",
        30_000,
      );
      if (smoke.exitCode === 0 && smoke.stdout.includes("RITTY_EXECUTION_OK")) {
        db.setKV("ritty_execution_smoke_v1", "passed");
        logger.info("[SMOKE TEST] Execution path PASS: file write + shell command + result verification completed.");
      } else {
        logger.warn(
          "[SMOKE TEST] Execution path FAIL: " +
          `exit=${smoke.exitCode} stdout=${smoke.stdout.slice(0, 120)} stderr=${smoke.stderr.slice(0, 120)}`,
        );
      }
    } catch (error) {
      logger.warn(
        `[SMOKE TEST] Execution path error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ─── The Loop ──────────────────────────────────────────────

  const MAX_IDLE_TURNS = 10; // Force sleep after N turns with no real work
  let idleTurnCount = 0;

  const maxCycleTurns = config.maxTurnsPerCycle ?? 25;
  let cycleTurnCount = 0;

  // Check creator/inbox work before the synthetic wakeup prompt.
  // This prevents dashboard commands from waiting behind a wakeup turn.
  let pendingInput: { content: string; source: string } | undefined;
  let wakeupPending = true;

  while (running) {
    // Declared outside try so the catch block can access for retry/failure handling
    let claimedMessages: InboxMessageRow[] = [];

    try {
      // A queued creator command must wake the loop even if a prior
      // autonomous turn left a future sleep_until timestamp behind.
      const creatorWaiting = !!db.raw.prepare(
        "SELECT 1 FROM inbox_messages WHERE status = 'received' AND from_address = 'dashboard://creator' LIMIT 1",
      ).get();
      const creatorTaskActive = !!db.getKV("creator_task_active");
      // Check if we should be sleeping, but never sleep through creator work.
      const sleepUntil = db.getKV("sleep_until");
      if (
        sleepUntil &&
        new Date(sleepUntil) > new Date() &&
        !creatorWaiting &&
        !creatorTaskActive &&
        pendingInput?.source !== "creator"
      ) {
        log(config, `[SLEEP] Sleeping until ${sleepUntil}`);
        // IMPORTANT: mark agent as sleeping so the outer runtime pauses instead of immediately re-running.
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // Check for unprocessed inbox messages using the state machine:
      // received → in_progress (claim) → processed (on success) or received/failed (on failure)
      if (!pendingInput) {
        claimedMessages = claimInboxMessages(db.raw, 10);
        if (claimedMessages.length > 0) {
          const formatted = claimedMessages
            .map((m) => {
              const from = sanitizeInput(m.fromAddress, m.fromAddress, "social_address");
              const content = sanitizeInput(m.content, m.fromAddress, "social_message");
              if (content.blocked) {
                return `[INJECTION BLOCKED from ${from.content}]: message was blocked by safety filter`;
              }
              return `[Message from ${from.content}]: ${content.content}`;
            })
            .join("\n\n");
          const hasCreatorMessage = claimedMessages.some(
            (m) => m.fromAddress === "dashboard://creator",
          );
          pendingInput = {
            content: formatted,
            source: hasCreatorMessage ? "creator" : "agent",
          };
          if (hasCreatorMessage) {
            // Persist the creator task across tool-only turns. Inbox messages are
            // acknowledged after each turn, but implementation commonly needs
            // several inference/tool cycles to finish.
            db.setKV("creator_task_active", formatted);
          }
        } else if (db.getKV("creator_task_active")) {
          pendingInput = {
            content:
              "CONTINUE THE ACTIVE CREATOR TASK. Do not restart from scratch; inspect prior tool results and continue implementation until the work is actually complete or blocked by a specific missing capability. Active command:\n" +
              db.getKV("creator_task_active"),
            source: "creator",
          };
        } else if (wakeupPending) {
          pendingInput = { content: wakeupInput, source: "wakeup" };
          wakeupPending = false;
        }
      }

      // Refresh financial state periodically
      financial = await getFinancialState(conway, identity.address, db, config.chainType || identity.chainType || "evm");

      // Check survival tier
      // api_unreachable: creditsCents === -1 means API failed with no cache.
      // Do NOT kill the agent; continue in low-compute mode and retry next tick.
      if (financial.creditsCents === -1) {
        log(config, "[API_UNREACHABLE] Balance API unreachable, continuing in low-compute mode.");
        inference.setLowComputeMode(true);
      } else {
        const tier = getSurvivalTier(financial.creditsCents);

        // Inline auto-topup: if credits are critically low and USDC is
        // available, buy credits NOW — before attempting inference.
        // This prevents the agent from dying mid-loop while waiting for
        // the heartbeat to fire. Uses a 60s cooldown to avoid hammering.
        if ((tier === "critical" || tier === "low_compute") && financial.usdcBalance >= 5) {
          const INLINE_TOPUP_COOLDOWN_MS = 60_000;
          const lastInlineTopup = db.getKV("last_inline_topup_attempt");
          const cooldownExpired = !lastInlineTopup ||
            Date.now() - new Date(lastInlineTopup).getTime() >= INLINE_TOPUP_COOLDOWN_MS;

          if (cooldownExpired) {
            db.setKV("last_inline_topup_attempt", new Date().toISOString());
            try {
              const { bootstrapTopup } = await import("../conway/topup.js");
              const topupResult = await bootstrapTopup({
                apiUrl: config.conwayApiUrl,
                account: identity.account,
                creditsCents: financial.creditsCents,
                chainType: config.chainType || identity.chainType || "evm",
              });
              if (topupResult?.success) {
                log(config, `[AUTO-TOPUP] Bought $${topupResult.amountUsd} credits from USDC mid-loop`);
                // Re-fetch financial state after topup so the rest of
                // the turn sees the updated balance.
                financial = await getFinancialState(conway, identity.address, db, config.chainType || identity.chainType || "evm");
              }
            } catch (err: any) {
              logger.warn(`Inline auto-topup failed: ${err.message}`);
            }
          }
        }

        // Re-evaluate tier after potential topup
        const effectiveTier = getSurvivalTier(financial.creditsCents);

        if (effectiveTier === "critical") {
          log(config, "[CRITICAL] Credits critically low. Limited operation.");
          db.setAgentState("critical");
          onStateChange?.("critical");
          inference.setLowComputeMode(true);
        } else if (effectiveTier === "low_compute") {
          db.setAgentState("low_compute");
          onStateChange?.("low_compute");
          inference.setLowComputeMode(true);
        } else {
          if (db.getAgentState() !== "running") {
            db.setAgentState("running");
            onStateChange?.("running");
          }
          inference.setLowComputeMode(false);
        }
      }

      // Build context — filter out purely idle turns (only status checks)
      // to prevent the model from continuing a status-check pattern
      const allTurns = db.getRecentTurns(20);
      const meaningfulTurns = allTurns.filter((t) => {
        if (t.toolCalls.length === 0) return true; // text-only turns are meaningful
        return t.toolCalls.some((tc) => !isIdleOnlyTool(getObservedToolName(tc)));
      });
      // Keep at least the last 2 turns for continuity, even if idle
      const recentTurns = trimContext(
        meaningfulTurns.length > 0 ? meaningfulTurns : allTurns.slice(-2),
      );
      const systemPrompt = buildSystemPrompt({
        identity,
        config,
        financial,
        state: db.getAgentState(),
        db,
        tools,
        skills,
        isFirstRun,
      });

      // Phase 2.2: Pre-turn memory retrieval
      let memoryBlock: string | undefined;
      try {
        const sessionId = db.getKV("session_id") || "default";
        const retriever = new MemoryRetriever(db.raw, DEFAULT_MEMORY_BUDGET);
        const memories = retriever.retrieve(sessionId, pendingInput?.content);
        if (memories.totalTokens > 0) {
          memoryBlock = formatMemoryBlock(memories);
        }
      } catch (error) {
        logger.error("Memory retrieval failed", error instanceof Error ? error : undefined);
        // Memory failure must not block the agent loop
      }

      let messages = buildContextMessages(
        systemPrompt,
        recentTurns,
        pendingInput,
      );

      // Inject memory block after system prompt, before conversation history
      if (memoryBlock) {
        messages.splice(1, 0, { role: "system", content: memoryBlock });
      }

      // Recover stale orchestration work even while a creator command is active.
      // Creator execution intentionally bypasses orchestrator.tick(), so stale
      // assignments must be recovered independently or they can remain stuck forever.
      if (orchestrator) {
        const now = Date.now();
        const staleTasks = db.raw.prepare(
          `SELECT t.id, t.assigned_to, t.status, t.started_at, t.created_at, t.timeout_ms,
                  g.title AS goal_title, g.description AS goal_description
           FROM task_graph t
           LEFT JOIN goals g ON g.id = t.goal_id
           WHERE t.status IN ('assigned', 'running')
             AND t.assigned_to IS NOT NULL`,
        ).all() as Array<{
          id: string;
          assigned_to: string;
          status: string;
          started_at: string | null;
          created_at: string;
          timeout_ms: number;
          goal_title: string | null;
          goal_description: string | null;
        }>;

        const creatorExecutionActive = creatorTaskActive || pendingInput?.source === "creator";

        for (const task of staleTasks) {
          const isSelfAssigned = task.assigned_to === identity.address;

          if (isSelfAssigned) {
            // A self-assigned task has no independent worker heartbeat.
            // Recover it when it is stale, but never touch financial/wallet
            // goals automatically.
            const goalText = `${task.goal_title ?? ""} ${task.goal_description ?? ""}`.toLowerCase();
            const financialLike =
              /(wallet|transfer|trading|trade|investment|invest|payment|money|finance|financial|crypto|bitcoin|usdc|currency|exchange)/i.test(goalText);
            const selfLeaseOrigin = task.started_at ?? task.created_at;
            const selfAgeMs = Math.max(0, now - new Date(selfLeaseOrigin).getTime());
            const selfTimeoutMs = Math.max(60_000, Number(task.timeout_ms) || 300_000);
            const shouldRecoverSelfTask =
              !financialLike &&
              (
                (creatorExecutionActive && selfAgeMs >= 60_000) ||
                (!creatorExecutionActive && selfAgeMs >= selfTimeoutMs)
              );

            if (shouldRecoverSelfTask) {
              logger.warn("[ORCHESTRATION] Releasing stale self-assigned task", {
                taskId: task.id,
                previousStatus: task.status,
                ageMs: selfAgeMs,
                timeoutMs: selfTimeoutMs,
                creatorExecutionActive,
              });
              db.raw.prepare(
                "UPDATE task_graph SET status = 'pending', assigned_to = NULL, started_at = NULL WHERE id = ?",
              ).run(task.id);
              db.raw.prepare("DELETE FROM kv WHERE key = ?").run(`orchestrator.task_lease.${task.id}`);
            }
            continue;
          }

          let alive = false;
          if (task.assigned_to.startsWith("local://")) {
            alive = workerPool?.hasWorker(task.assigned_to) ?? false;
          } else {
            const child = db.raw.prepare(
              "SELECT status FROM children WHERE sandbox_id = ? OR address = ?",
            ).get(task.assigned_to, task.assigned_to) as { status: string } | undefined;
            alive = !!child && !["failed", "dead", "cleaned_up"].includes(child.status);
          }

          const leaseKey = `orchestrator.task_lease.${task.id}`;
          const leaseValue = db.raw.prepare(
            "SELECT value FROM kv WHERE key = ?",
          ).get(leaseKey) as { value?: string } | undefined;
          const leaseOrigin = task.started_at ?? leaseValue?.value ?? task.created_at;
          const leaseStartedAt = new Date(leaseOrigin).getTime();
          const timeoutMs = Math.max(60_000, Number(task.timeout_ms) || 300_000);
          const ageMs = Number.isFinite(leaseStartedAt) ? Math.max(0, now - leaseStartedAt) : 0;
          const legacyStale = !task.started_at && !leaseValue?.value && ageMs >= 120_000;
          const timedOutRemote = !task.assigned_to.startsWith("local://") && ageMs >= timeoutMs;

          if (!alive || legacyStale || timedOutRemote) {
            logger.warn("[ORCHESTRATION] Recovering stale task outside orchestrator tick", {
              taskId: task.id,
              worker: task.assigned_to,
              previousStatus: task.status,
              alive,
              ageMs,
              timeoutMs,
              legacyStale,
              timedOutRemote,
            });
            db.raw.prepare(
              "UPDATE task_graph SET status = 'pending', assigned_to = NULL, started_at = NULL WHERE id = ?",
            ).run(task.id);
            db.raw.prepare("DELETE FROM kv WHERE key = ?").run(leaseKey);

            if (timedOutRemote && alive) {
              db.raw.prepare(
                "UPDATE children SET status = 'failed', last_checked = datetime('now') WHERE address = ?",
              ).run(task.assigned_to);
            }
          }
        }
      }

      if (orchestrator && pendingInput?.source !== "creator") {
        const orchestratorTick = await orchestrator.tick();
        db.setKV("orchestrator.last_tick", JSON.stringify(orchestratorTick));
        const localWorkersActive = workerPool?.getActiveCount() ?? 0;
        const hasSelfAssignedParentTask = !!db.raw.prepare(
          `SELECT 1 FROM task_graph WHERE assigned_to = ? AND status IN ('assigned', 'running') LIMIT 1`,
        ).get(identity.address);

        if (
          // Never park the parent loop while a creator command is waiting.
          // Creator commands must reach inference immediately even when
          // autonomous worker agents are active on an unrelated goal.
          pendingInput?.source !== "creator" &&
          orchestratorTick.phase === "executing" &&
          orchestratorTick.tasksAssigned === 0 &&
          orchestratorTick.tasksCompleted === 0 &&
          orchestratorTick.tasksFailed === 0 &&
          !hasSelfAssignedParentTask &&
          (orchestratorTick.agentsActive > 0 || localWorkersActive > 0)
        ) {
          log(
            config,
            "[ORCHESTRATOR] All delegated work is active and no self-assigned parent task remains. Sleeping to avoid idle loop.",
          );
          db.setKV("sleep_until", new Date(Date.now() + 60_000).toISOString());
          db.setAgentState("sleeping");
          onStateChange?.("sleeping");
          running = false;
          break;
        }

        if (
          orchestratorTick.tasksAssigned > 0 ||
          orchestratorTick.tasksCompleted > 0 ||
          orchestratorTick.tasksFailed > 0
        ) {
          log(
            config,
            `[ORCHESTRATOR] phase=${orchestratorTick.phase} assigned=${orchestratorTick.tasksAssigned} completed=${orchestratorTick.tasksCompleted} failed=${orchestratorTick.tasksFailed}`,
          );
        }
      }

      if (planModeController) {
        try {
          const todoMd = generateTodoMd(db.raw);
          messages = injectTodoContext(messages, todoMd);
        } catch (error) {
          logger.warn(
            `todo.md context injection skipped: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      if (process.env.RITTY_MODE === "sovereign") {
        messages.push({
          role: "system",
          content:
            "SOVEREIGN EXECUTION RULE: Do not repeatedly check credits or status. " +
            "One credit check is enough unless a real decision requires a fresh balance. " +
            "After a successful status check, execute ONE concrete useful non-financial task from your goals/genesis prompt, " +
            "or sleep if there is genuinely no work. Do not call the same status tool on consecutive turns. " +
            "Never initiate transfers, trades, wallet actions, crypto work, currency conversion, payments, or other financial activity autonomously. " +
            "When a financial goal is already active but no creator command is being processed, do not advance that goal; instead perform only safe runtime/tool diagnostics.",
        });
      }

      // Creator-command override: the dashboard is an explicit instruction
      // from the owner and must be acted on in the current turn.
      if (pendingInput?.source === "creator") {
        messages.push({
          role: "system",
          content:
            "CREATOR COMMAND — HIGHEST PRIORITY: The user/creator has just sent the task " +
            "shown in the current input. Execute that task NOW using the available tools. " +
            "Do NOT call check_credits, orchestrator_status, list_goals, get_plan, or create_goal " +
            "as a preliminary step. Do NOT sleep. Do NOT defer the task to a background goal. " +
            "Do NOT merely describe what you would do. Start the concrete implementation immediately. " +
            "Use as many tool calls as needed within the normal per-turn limit, then continue on " +
            "subsequent turns until the requested work is actually completed and verified. " +
            "Never perform financial transfers or wallet operations for this creator task. " +
            "The runtime root package.json, config.json, wallet.json, state database, SOUL.md, " +
            "policy/guard files, and other protected runtime files are read-only. NEVER attempt to write, " +
            "replace, or install dependencies through those files. For coding tasks, use the existing " +
            "Node.js runtime and built-in modules whenever possible. The sovereign sandbox home is /root; " +
            "do NOT use /home/ritty, /home/agent, or other assumed home directories. Create application source files in " +
            "/root/workspace/<project> (or ./workspace/<project>) and verify them with the exec tool. Node.js and pnpm " +
            "are available at runtime; npm and Python may not be installed. Do not stop at a plan or explanation.",
        });
      }

      // Capture input before clearing
      const currentInput = pendingInput;

      // Clear pending input after use
      pendingInput = undefined;

      // ── Inference Call (via router when available) ──
      const survivalTier = getSurvivalTier(financial.creditsCents);
      log(config, `[THINK] Routing inference (tier: ${survivalTier}, model: ${inference.getDefaultModel()})...`);

      const CREATOR_BLOCKED_TOOLS = new Set([
        "check_credits",
        "check_usdc_balance",
        "orchestrator_status",
        "list_goals",
        "get_plan",
        "create_goal",
        "sleep",
        "modify_heartbeat",
        "topup_credits",
        "transfer_credits",
      ]);
      const creatorToolSet = new Set([
        "read_file",
        "exec",
        "write_file",
        "edit_own_file",
        "git_status",
        "git_diff",
        "git_commit",
        "git_push",
        "git_pull",
        "git_clone",
        "git_branch",
        "review_upstream_changes",
      ]);

      // Deterministic guard: once an autonomous goal exists, the parent must
      // continue that goal instead of asking the model to create another one.
      // This is done at tool-exposure time so even malformed model arguments
      // cannot re-enter create_goal.
      const activeGoalExists =
        currentInput?.source !== "creator" &&
        getActiveGoals(db.raw).length > 0;

      const inferenceToolSource =
        currentInput?.source === "creator"
          ? tools.filter((tool) => creatorToolSet.has(tool.name) && !CREATOR_BLOCKED_TOOLS.has(tool.name))
          : activeGoalExists
            ? tools.filter((tool) => tool.name !== "create_goal")
            : tools;
      const inferenceTools = toolsToInferenceFormat(inferenceToolSource);
      const routerResult = await inferenceRouter.route(
        {
          messages: messages,
          taskType: "agent_turn",
          tier: survivalTier,
          sessionId: db.getKV("session_id") || "default",
          turnId: ulid(),
          tools: inferenceTools,
        },
        (msgs, opts) => inference.chat(msgs, { ...opts, tools: inferenceTools }),
      );

      // Build a compatible response for the rest of the loop
      const response = {
        message: { content: routerResult.content, role: "assistant" as const },
        toolCalls: routerResult.toolCalls as any[] | undefined,
        usage: {
          promptTokens: routerResult.inputTokens,
          completionTokens: routerResult.outputTokens,
          totalTokens: routerResult.inputTokens + routerResult.outputTokens,
        },
        finishReason: routerResult.finishReason,
      };

      const turn: AgentTurn = {
        id: ulid(),
        timestamp: new Date().toISOString(),
        state: db.getAgentState(),
        input: currentInput?.content,
        inputSource: currentInput?.source as any,
        thinking: response.message.content || "",
        toolCalls: [],
        tokenUsage: response.usage,
        costCents: routerResult.costCents,
      };

      // ── Execute Tool Calls ──
      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolCallMessages: any[] = [];
        let callCount = 0;
        const currentInputSource = currentInput?.source as InputSource | undefined;
        toolContext.inputSource = currentInputSource;

        for (const tc of response.toolCalls) {
          if (callCount >= MAX_TOOL_CALLS_PER_TURN) {
            log(config, `[TOOLS] Max tool calls per turn reached (${MAX_TOOL_CALLS_PER_TURN})`);
            break;
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch (error) {
            logger.error("Failed to parse tool arguments", error instanceof Error ? error : undefined);
            args = {};
          }

          log(config, `[TOOL] ${tc.function.name}(${JSON.stringify(args).slice(0, 100)})`);

          const result = await executeTool(
            tc.function.name,
            args,
            tools,
            toolContext,
            policyEngine,
            spendTracker ? {
              inputSource: currentInputSource,
              turnToolCallCount: turn.toolCalls.filter(t => t.name === "transfer_credits").length,
              sessionSpend: spendTracker,
            } : undefined,
          );

          // Override the ID to match the inference call's ID
          result.id = tc.id;
          turn.toolCalls.push(result);

          log(
            config,
            `[TOOL RESULT] ${tc.function.name}: ${result.error ? `ERROR: ${result.error}` : result.result.slice(0, 200)}`,
          );

          callCount++;
        }
      }

      // ── Persist Turn (atomic: turn + tool calls + inbox ack) ──
      const claimedIds = claimedMessages.map((m) => m.id);
      if (currentInput?.source === "creator") {
        const CREATOR_MUTATING_TOOLS = new Set([
          "exec", "write_file", "edit_own_file", "git_commit", "git_push",
          "git_pull", "git_clone", "git_branch",
        ]);
        if (turn.toolCalls.some((tc) => CREATOR_MUTATING_TOOLS.has(getObservedToolName(tc)) && !tc.error)) {
          db.setKV("creator_task_progress", "1");
        }
      }
      db.runTransaction(() => {
        db.insertTurn(turn);
        for (const tc of turn.toolCalls) {
          db.insertToolCall(turn.id, tc);
        }
        // Mark claimed inbox messages as processed (atomic with turn persistence)
        if (claimedIds.length > 0) {
          markInboxProcessed(db.raw, claimedIds);
        }
      });
      onTurnComplete?.(turn);

      // Phase 2.2: Post-turn memory ingestion (non-blocking)
      try {
        const sessionId = db.getKV("session_id") || "default";
        const ingestion = new MemoryIngestionPipeline(db.raw);
        ingestion.ingest(sessionId, turn, turn.toolCalls);
      } catch (error) {
        logger.error("Memory ingestion failed", error instanceof Error ? error : undefined);
        // Memory failure must not block the agent loop
      }

      // ── create_goal BLOCKED fast-break ──
      // When a goal is already active, the parent loop has nothing useful to do.
      // Force sleep immediately on first BLOCKED (not second) with exponential
      // backoff so the agent doesn't wake every 2 minutes just to get BLOCKED again.
      const blockedGoalCall = turn.toolCalls.find(
        (tc) => getObservedToolName(tc) === "create_goal" && tc.result?.includes("BLOCKED"),
      );
      if (blockedGoalCall && currentInput?.source !== "creator") {
        // An active goal is already in progress. Do not park the parent loop:
        // yield immediately back to the orchestrator and force the next model
        // turn to continue the existing work. This removes the old 10s/120s+
        // duplicate-goal sleep cycle.
        if (getActiveGoals(db.raw).length > 0) {
          db.deleteKV("blocked_goal_backoff");
          pendingInput = {
            content:
              "DUPLICATE GOAL BLOCKED. An active goal already exists. " +
              "Do NOT call create_goal again. Continue the existing active goal " +
              "through the orchestrator and execute its pending work.",
            source: "system",
          };
          log(config, "[LOOP] create_goal BLOCKED — continuing active goal without sleep.");
          continue;
        }

        // No active goal exists: back off only when there is genuinely no work.
        const prevBackoff = parseInt(db.getKV("blocked_goal_backoff") || "0", 10);
        const backoffMs = Math.min(prevBackoff > 0 ? prevBackoff * 2 : 120_000, 600_000);
        db.setKV("blocked_goal_backoff", String(backoffMs));
        log(config, `[LOOP] create_goal BLOCKED — sleeping ${Math.round(backoffMs / 1000)}s (backoff).`);
        db.setKV("sleep_until", new Date(Date.now() + backoffMs).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      } else if (turn.toolCalls.some((tc) => getObservedToolName(tc) === "create_goal" && !tc.error)) {
        // Goal was successfully created — reset backoff
        db.deleteKV("blocked_goal_backoff");
      }

      // ── Loop Detection ──
      if (turn.toolCalls.length > 0) {
        const currentPattern = turn.toolCalls
          .map((tc) => getObservedToolName(tc))
          .sort()
          .join(",");
        lastToolPatterns.push(currentPattern);

        // Keep only the last MAX_REPETITIVE_TURNS entries
        if (lastToolPatterns.length > MAX_REPETITIVE_TURNS) {
          lastToolPatterns = lastToolPatterns.slice(-MAX_REPETITIVE_TURNS);
        }

        // Reset enforcement tracker if agent changed behavior
        if (loopWarningPattern && currentPattern !== loopWarningPattern) {
          loopWarningPattern = null;
        }

        // ── Loop Enforcement Escalation ──
        // If we already warned about this pattern and the agent STILL repeats, force sleep.
        if (
          loopWarningPattern &&
          currentPattern === loopWarningPattern &&
          lastToolPatterns.length === MAX_REPETITIVE_TURNS &&
          lastToolPatterns.every((p) => p === currentPattern)
        ) {
          log(config, `[LOOP] Enforcement: agent ignored loop warning, forcing sleep.`);
          pendingInput = {
            content:
              `LOOP ENFORCEMENT: You were warned about repeating "${currentPattern}" but continued. ` +
              `Forcing sleep to prevent credit waste. On next wake, try a DIFFERENT approach.`,
            source: "system",
          };
          loopWarningPattern = null;
          lastToolPatterns = [];
          db.setAgentState("sleeping");
          onStateChange?.("sleeping");
          running = false;
          break;
        }

        // Check if the same pattern repeated MAX_REPETITIVE_TURNS times
        if (
          lastToolPatterns.length === MAX_REPETITIVE_TURNS &&
          lastToolPatterns.every((p) => p === currentPattern)
        ) {
          log(config, `[LOOP] Repetitive pattern detected: ${currentPattern}`);
          pendingInput = {
            content:
              `LOOP DETECTED: You have called "${currentPattern}" ${MAX_REPETITIVE_TURNS} times in a row with similar results. ` +
              `STOP repeating yourself. You already know your status. DO SOMETHING DIFFERENT NOW. ` +
              `Pick ONE concrete task from your genesis prompt and execute it.`,
            source: "system",
          };
          loopWarningPattern = currentPattern;
          lastToolPatterns = [];
        }

        // Detect multi-tool maintenance loops: all tools in the turn are idle-only,
        // even if the specific combination varies across consecutive turns.
        const isAllIdleTools = turn.toolCalls.every((tc) => isIdleOnlyTool(getObservedToolName(tc)));
        if (isAllIdleTools) {
          idleToolTurns++;
          if (idleToolTurns >= MAX_REPETITIVE_TURNS && !pendingInput) {
            log(config, `[LOOP] Maintenance loop detected: ${idleToolTurns} consecutive idle-only turns`);
            pendingInput = {
              content:
                `MAINTENANCE LOOP DETECTED: Your last ${idleToolTurns} turns only used status-check tools ` +
                `(${turn.toolCalls.map((tc) => getObservedToolName(tc)).join(", ")}). ` +
                `You already know your status. Review your genesis prompt and SOUL.md, then execute a CONCRETE task. ` +
                `Write code, create a file, register a service, or build something new.`,
              source: "system",
            };
            idleToolTurns = 0;
          }
        } else {
          idleToolTurns = 0;
        }
      }

      // Log the turn
      if (turn.thinking) {
        log(config, `[THOUGHT] ${turn.thinking.slice(0, 300)}`);
      }

      // ── Check for sleep command ──
      const sleepTool = turn.toolCalls.find((tc) => getObservedToolName(tc) === "sleep");
      if (sleepTool && !sleepTool.error) {
        log(config, "[SLEEP] Agent chose to sleep.");
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── Idle turn detection ──
      // If this turn had no pending input and didn't do any real work
      // (no mutations — only read/check/list/info tools), count as idle.
      // Use a blocklist of mutating tools rather than an allowlist of safe ones.
      const MUTATING_TOOLS = new Set([
        "exec", "write_file", "edit_own_file", "transfer_credits", "topup_credits", "fund_child",
        "spawn_child", "start_child", "delete_sandbox", "create_sandbox",
        "install_npm_package", "install_mcp_server", "install_skill",
        "create_skill", "remove_skill", "install_skill_from_git",
        "install_skill_from_url", "pull_upstream", "git_commit", "git_push",
        "git_branch", "git_clone", "send_message", "message_child",
        "register_domain", "register_erc8004", "give_feedback",
        "update_genesis_prompt", "update_agent_card", "modify_heartbeat",
        "expose_port", "remove_port", "x402_fetch", "manage_dns",
        "distress_signal", "prune_dead_children", "sleep",
        "update_soul", "remember_fact", "set_goal", "complete_goal",
        "save_procedure", "note_about_agent", "forget",
        "enter_low_compute", "switch_model", "review_upstream_changes",
      ]);
      const didMutate = turn.toolCalls.some((tc) => MUTATING_TOOLS.has(getObservedToolName(tc)));

      if (!currentInput && !didMutate) {
        idleTurnCount++;
        if (idleTurnCount >= MAX_IDLE_TURNS) {
          log(config, `[IDLE] ${idleTurnCount} consecutive idle turns with no work. Entering sleep.`);
          db.setKV("sleep_until", new Date(Date.now() + 60_000).toISOString());
          db.setAgentState("sleeping");
          onStateChange?.("sleeping");
          running = false;
        }
      } else {
        idleTurnCount = 0;
      }

      // ── Cycle turn limit ──
      // Hard ceiling on turns per wake cycle, regardless of tool type.
      // Prevents runaway loops where mutating tools (exec, write_file)
      // defeat idle detection indefinitely.
      cycleTurnCount++;
      if (running && cycleTurnCount >= maxCycleTurns) {
        log(config, `[CYCLE LIMIT] ${cycleTurnCount} turns reached (max: ${maxCycleTurns}). Forcing sleep.`);
        db.setKV("sleep_until", new Date(Date.now() + 120_000).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── If no tool calls and just text, the agent might be done thinking ──
      if (
        running &&
        (!response.toolCalls || response.toolCalls.length === 0) &&
        response.finishReason === "stop"
      ) {
        // A text-only response closes a creator task; tool-only turns retain
        // the task so the next loop iteration continues from saved history.
        if (currentInput?.source === "creator") {
          const creatorProgress = db.getKV("creator_task_progress") === "1";
          if (creatorProgress) {
            db.deleteKV("creator_task_active");
            db.deleteKV("creator_task_progress");
            log(config, "[CREATOR] Task returned final text after concrete implementation progress.");
          } else {
            // Do not let the model terminate an untouched creator task with prose.
            // Requeue the active task immediately for another implementation turn.
            const activeCreator = db.getKV("creator_task_active") || currentInput.content;
            db.setKV("creator_task_active", activeCreator);
            pendingInput = {
              content:
                "CONTINUE THE CREATOR TASK NOW. The previous turn produced no concrete tool action. " +
                "Do not answer with a plan or status. Use read_file/exec/edit_own_file/git tools to make an actual change. " +
                "Do not finish until you have made and verified a concrete implementation change.\n" +
                activeCreator,
              source: "creator",
            };
            db.deleteKV("sleep_until");
            log(config, "[CREATOR] Text-only response rejected; continuing task until concrete work is performed.");
          }
        }
        // Agent produced text without tool calls.
        // This is a natural pause point -- no work queued, sleep briefly.
        log(config, "[IDLE] No pending inputs. Entering brief sleep.");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 60_000).toISOString(),
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
      }

      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      log(config, `[ERROR] Turn failed: ${err.message}`);

      // Handle inbox message state on turn failure:
      // Messages that have retries remaining go back to 'received';
      // messages that have exhausted retries move to 'failed'.
      if (claimedMessages.length > 0) {
        const exhausted = claimedMessages.filter((m) => m.retryCount >= m.maxRetries);
        const retryable = claimedMessages.filter((m) => m.retryCount < m.maxRetries);

        if (exhausted.length > 0) {
          markInboxFailed(db.raw, exhausted.map((m) => m.id));
          log(config, `[INBOX] ${exhausted.length} message(s) moved to failed (max retries exceeded)`);
        }
        if (retryable.length > 0) {
          resetInboxToReceived(db.raw, retryable.map((m) => m.id));
          log(config, `[INBOX] ${retryable.length} message(s) reset to received for retry`);
        }
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log(
          config,
          `[FATAL] ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Sleeping.`,
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 300_000).toISOString(),
        );
        running = false;
      }
    }
  }

  log(config, `[LOOP END] Agent loop finished. State: ${db.getAgentState()}`);
}

// ─── Helpers ───────────────────────────────────────────────────

// Cache last known good balances so transient API failures don't
// cause the automaton to believe it has $0 and kill itself.
let _lastKnownCredits = 0;
let _lastKnownUsdc = 0;

async function getFinancialState(
  conway: ConwayClient,
  address: string,
  db?: AutomatonDatabase,
  chainType?: string,
): Promise<FinancialState> {
  let creditsCents = _lastKnownCredits;
  let usdcBalance = _lastKnownUsdc;

  try {
    creditsCents = await conway.getCreditsBalance();
    if (creditsCents > 0) _lastKnownCredits = creditsCents;
  } catch (error) {
    logger.error("Credits balance fetch failed", error instanceof Error ? error : undefined);
    // Use last known balance from KV, not zero
    if (db) {
      const cached = db.getKV("last_known_balance");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          logger.warn("Balance API failed, using cached balance");
          return {
            creditsCents: parsed.creditsCents ?? 0,
            usdcBalance: parsed.usdcBalance ?? 0,
            lastChecked: new Date().toISOString(),
          };
        } catch (parseError) {
          logger.error("Failed to parse cached balance", parseError instanceof Error ? parseError : undefined);
        }
      }
    }
    // No cache available -- return conservative non-zero sentinel
    logger.error("Balance API failed, no cache available");
    return {
      creditsCents: -1,
      usdcBalance: -1,
      lastChecked: new Date().toISOString(),
    };
  }

  if (process.env.RITTY_MODE === "sovereign") {
    // Sovereign mode has no Conway/x402 treasury dependency. Keep the
    // operational balance metric local and avoid unnecessary RPC calls.
    usdcBalance = 0;
  } else {
    try {
      const network = chainType === "solana" ? "solana:mainnet" : "eip155:8453";
      usdcBalance = await getUsdcBalance(address, network, chainType as any);
      if (usdcBalance > 0) _lastKnownUsdc = usdcBalance;
    } catch (error) {
      logger.error("USDC balance fetch failed", error instanceof Error ? error : undefined);
    }
  }

  // Cache successful balance reads
  if (db) {
    try {
      db.setKV(
        "last_known_balance",
        JSON.stringify({ creditsCents, usdcBalance }),
      );
    } catch (error) {
      logger.error("Failed to cache balance", error instanceof Error ? error : undefined);
    }
  }

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

function log(_config: AutomatonConfig, message: string): void {
  logger.info(message);
}

function hasTable(db: AutomatonDatabase["raw"], tableName: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}
