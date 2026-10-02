import type { ChatMessage } from "../types.js";

export const SOVEREIGN_GROQ_MAX_OUTPUT_TOKENS = 2500;
const SYSTEM_CHARS = 6000;
const MEMORY_CHARS = 600;
const RECENT_CHARS = 2400;

export function compactSovereignGroqMessages(
  messages: ChatMessage[],
  emergency = false,
): ChatMessage[] {
  if (messages.length === 0) return messages;

  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  const systemLimit = emergency ? 3600 : SYSTEM_CHARS;
  const memoryLimit = emergency ? 300 : MEMORY_CHARS;
  const recentLimit = emergency ? 1200 : RECENT_CHARS;

  const result: ChatMessage[] = [];
  const primarySystem = systemMessages[0];
  const latestSystem = systemMessages.length > 1 ? systemMessages[systemMessages.length - 1] : undefined;

  if (primarySystem) {
    result.push({ ...primarySystem, content: truncate(primarySystem.content, systemLimit) });
  }
  if (latestSystem && latestSystem !== primarySystem) {
    result.push({ ...latestSystem, content: truncate(latestSystem.content, memoryLimit) });
  }

  let start = Math.max(0, nonSystem.length - 4);
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    if (nonSystem[i].role === "user") {
      start = i;
      break;
    }
  }

  let recent = nonSystem.slice(start);
  while (recent.length > 1 && charCount(recent) > recentLimit) {
    recent = [recent[0], ...recent.slice(2)];
  }

  recent = recent.map((m) => ({
    ...m,
    content: truncate(
      m.content,
      m.role === "user" ? 1200 : m.role === "assistant" ? 900 : 1000,
    ),
  }));

  return [...result, ...recent];
}

export function isGroqTpmError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /tokens per minute|rate_limit_exceeded.*tokens/i.test(text);
}

function charCount(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    let n = m.content?.length ?? 0;
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
    if (m.tool_call_id) n += m.tool_call_id.length;
    return sum + n;
  }, 0);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n…[groq context compacted]…\n";
  const available = Math.max(64, maxChars - marker.length);
  const head = Math.floor(available * 0.7);
  return text.slice(0, head) + marker + text.slice(- (available - head));
}
