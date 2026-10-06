import type { AutomatonDatabase } from "../types.js";
import {
  checkpointWork,
  completeWork,
  createWork,
  executeWorkBundle,
  getWork,
  publishWork,
  recoverInterruptedWorks,
  startWork,
} from "./work-engine.js";

const SELF_TEST_KEY = "ritty_work_engine_e2e_v1";

export async function runWorkEngineSelfTest(db: AutomatonDatabase): Promise<void> {
  if (db.getKV(SELF_TEST_KEY) === "passed") return;

  const startedAt = Date.now();
  let failureInjected = false;
  let recoveryVerified = false;

  try {
    // A) Create -> execute -> intentionally fail -> capture diagnosis -> fix -> retest -> artifact -> complete.
    const work = createWork(db, {
      title: "RITTY work engine end-to-end self-test",
      description:
        "Deterministic non-financial validation of durable execution, failure capture, correction, testing, artifacts, checkpoints, recovery, and publish approval gating.",
      type: "system-self-test",
      successCriteria:
        "A work item must survive an intentional validation failure, be resumed, pass validation, register an artifact, recover from an interruption, and preserve the publication approval gate.",
    });

    const firstAttempt = await executeWorkBundle(db, work.id, {
      files: [
        {
          path: "e2e/result.txt",
          content: "INTENTIONALLY_WRONG",
        },
      ],
      testCommand: "test \"$(cat e2e/result.txt)\" = 'EXPECTED_OK'",
      artifacts: ["e2e/result.txt"],
      summary: "Intentional failure captured for recovery test.",
    });

    if (firstAttempt.completed || !/status=failed/.test(firstAttempt.test)) {
      throw new Error("Self-test failed to capture the intentional validation failure.");
    }
    failureInjected = true;

    checkpointWork(
      db,
      work.id,
      "diagnosis",
      "blocked",
      "Intentional test failure diagnosed; correction is ready to resume.",
      { expected: "EXPECTED_OK", observed: "INTENTIONALLY_WRONG" },
    );

    const corrected = await executeWorkBundle(db, work.id, {
      files: [
        {
          path: "e2e/result.txt",
          content: "EXPECTED_OK",
        },
      ],
      testCommand: "test \"$(cat e2e/result.txt)\" = 'EXPECTED_OK'",
      artifacts: ["e2e/result.txt"],
      summary:
        "Failure diagnosed and corrected; validation, artifact registration, and completion succeeded.",
    });

    if (!corrected.completed || !/status=passed/.test(corrected.test)) {
      throw new Error("Self-test correction/validation phase failed.");
    }

    // B) Simulate interruption and prove durable recovery + resume.
    const interrupted = createWork(db, {
      title: "RITTY work engine interruption recovery self-test",
      description: "Verify that in-progress work becomes resumable after runtime recovery.",
      type: "system-self-test-recovery",
      successCriteria: "Recovery marks the work interrupted and a subsequent resume can complete it.",
    });

    startWork(db, interrupted.id, "Self-test deliberately leaves this work in progress.");
    const recoveredCount = recoverInterruptedWorks(db);
    const recovered = getWork(db, interrupted.id);
    if (!recovered || recovered.status !== "interrupted" || recoveredCount < 1) {
      throw new Error("Self-test interruption recovery did not mark the work as interrupted.");
    }
    recoveryVerified = true;

    const resumed = await executeWorkBundle(db, interrupted.id, {
      files: [
        {
          path: "e2e/recovery.txt",
          content: "RECOVERY_OK",
        },
      ],
      testCommand: "test \"$(cat e2e/recovery.txt)\" = 'RECOVERY_OK'",
      artifacts: ["e2e/recovery.txt"],
      summary: "Interrupted work resumed from durable state and completed successfully.",
    });

    if (!resumed.completed || !/status=passed/.test(resumed.test)) {
      throw new Error("Self-test resume after interruption failed.");
    }

    // C) Verify publication is approval-gated without publishing anything externally.
    const publishGate = await publishWork(
      db,
      work.id,
      "git",
      work.workspacePath,
      false,
    );
    if (!publishGate.startsWith("PUBLISH_PENDING_APPROVAL:")) {
      throw new Error("Self-test publication approval gate failed.");
    }

    checkpointWork(
      db,
      work.id,
      "publish-gate",
      "in_progress",
      "Publication gate verified: no external publication occurs without explicit approval.",
    );
    completeWork(
      db,
      work.id,
      true,
      "E2E self-test passed: create, failure capture, diagnosis, correction, validation, artifacts, interruption recovery, resume, and publish gate.",
    );

    db.setKV(SELF_TEST_KEY, "passed");
    db.setKV("ritty_work_engine_e2e_last_run", new Date().toISOString());
    db.setKV(
      "ritty_work_engine_e2e_summary",
      JSON.stringify({
        failureCaptured: failureInjected,
        recoveryVerified,
        durationMs: Date.now() - startedAt,
      }),
    );
  } catch (error) {
    db.setKV("ritty_work_engine_e2e_last_run", new Date().toISOString());
    db.setKV(
      "ritty_work_engine_e2e_error",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
