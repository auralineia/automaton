
function isSelfDirectedTask(task: TaskNode): boolean {
  return task.title.trim().toLowerCase().startsWith("autonomous value-creation cycle");
}

function isSelfDirectedValueGoal(goal: GoalRow): boolean {
  const title = goal.title.trim().toLowerCase();
  const strategy = String(goal.strategy ?? "").trim().toLowerCase();
  return title.startsWith("autonomous value-creation cycle") ||
    strategy.includes("self-directed operation");
}

function createSelfDirectedTask(goal: GoalRow) {
  return {
    parentId: null,
    goalId: goal.id,
    title: goal.title,
    description:
      "Execute the goal-specific autonomous work below. " +
      "Research, design, implement, validate, and record the actual deliverable; do not substitute status-only work. " +
      "Store the finished artifact under /root/.automaton/workspace/" + goal.id + "/outputs/ and create cycle-report.md. " +
      "Do not send spam or unsolicited outreach. Do not make transfers, trades, wallet operations, " +
      "crypto transactions, currency conversion, payments, purchases, paid deployments, or binding commitments. " +
      "Goal brief follows:\n\n" + goal.description,
    status: "pending" as const,
    assignedTo: null,
    agentRole: "generalist",
    priority: 90,
    dependencies: [],
    result: null,
  };
}

function pickGoal(goals: GoalRow[], preferredId: string | null): GoalRow {
  if (preferredId) {
    const preferred = goals.find((goal) => goal.id === preferredId);
    if (preferred) {
      return preferred;
    }
  }

  return goals[0];
}

function clampPriority(priority: number, fallbackIndex: number): number {
  if (!Number.isFinite(priority)) {
    return Math.max(0, 50 - fallbackIndex);
  }

  return Math.max(0, Math.min(100, Math.floor(priority)));
}

function heuristicStepEstimate(goal: GoalRow): number {
  const words = `${goal.title} ${goal.description}`.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 40) return 6;
  if (words >= 24) return 5;
  if (words >= 12) return 4;
  return 2;
}

function clampSteps(value: number): number {
  if (!Number.isFinite(value)) {