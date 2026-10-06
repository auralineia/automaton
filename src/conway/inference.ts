/**
 * Conway Inference Client
 *
 * Wraps Conway's /v1/chat/completions endpoint (OpenAI-compatible).
 * The automaton pays for its own thinking through Conway credits.
 */

import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
  InferenceToolDefinition,
} from "../types.js";
import { ResilientHttpClient } from "./http-client.js";
import { compactSovereignGroqMessages, SOVEREIGN_GROQ_MAX_OUTPUT_TOKENS } from "./groq-context.js";
import { createLogger } from "../observability/logger.js";

const INFERENCE_TIMEOUT_MS = 30_000;
const SOVEREIGN_PROVIDER_RETRIES = 0;
const logger = createLogger("inference");

interface InferenceClientOptions {
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
  openaiApiKey?: string;
  groqApiKey?: string;
  geminiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  /** Optional registry lookup — if provided, used before name heuristics */
  getModelProvider?: (modelId: string) => string | undefined;
}

type InferenceBackend = "conway" | "openai" | "groq" | "gemini" | "anthropic" | "ollama";

function isLoopbackHttpUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol.toLowerCase() === "http:" &&
      (host === "localhost" || host === "127.0.0.1" || host === "::1");
  } catch {
    return false;
  }
}

export function createInferenceClient(
  options: InferenceClientOptions,
): InferenceClient {
  const { apiUrl, apiKey, openaiApiKey, groqApiKey, geminiApiKey, anthropicApiKey, ollamaBaseUrl, getModelProvider } = options;
  const httpClient = new ResilientHttpClient({
    baseTimeout: INFERENCE_TIMEOUT_MS,
    retryableStatuses: [429, 500, 502, 503, 504],
    allowHttpOnLoopback: isLoopbackHttpUrl(ollamaBaseUrl),
  });
  let currentModel = options.defaultModel;
  let maxTokens = options.maxTokens;
  let lastGroqRequestAt = 0;

  const throttleGroq = async (): Promise<void> => {
    if (process.env.RITTY_MODE !== "sovereign") return;
    const minIntervalMs = Number(process.env.RITTY_GROQ_MIN_INTERVAL_MS || 61000);
    if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) return;

    const elapsed = Date.now() - lastGroqRequestAt;
    const waitMs = Math.max(0, minIntervalMs - elapsed);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastGroqRequestAt = Date.now();
  };

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    const model = opts?.model || currentModel;
    const tools = opts?.tools;

    const backend = resolveInferenceBackend(model, {
      openaiApiKey,
      groqApiKey,
      geminiApiKey,
      anthropicApiKey,
      ollamaBaseUrl,
      getModelProvider,
    });

    // Newer models (o-series, gpt-5.x, gpt-4.1) require max_completion_tokens.
    // Ollama always uses max_tokens.
    const usesCompletionTokens =
      backend === "groq" ||
      (backend !== "ollama" && /^(o[1-9]|gpt-5|gpt-4\.1)/.test(model));
    const requestedTokenLimit = opts?.maxTokens || maxTokens;
    // Groq's current on-demand organization limits can reject a request when
    // prompt tokens plus requested completion tokens exceed the minute quota.
    // Keep sovereign turns bounded while preserving normal Conway/OpenAI limits.
    const isSovereignGroq = process.env.RITTY_MODE === "sovereign" && backend === "groq";
    const configuredGroqMaxOutput = Number(process.env.RITTY_GROQ_MAX_OUTPUT_TOKENS);
    const tokenLimit = isSovereignGroq
      ? Math.min(
          requestedTokenLimit,
          Number.isFinite(configuredGroqMaxOutput) && configuredGroqMaxOutput > 0
            ? Math.min(configuredGroqMaxOutput, SOVEREIGN_GROQ_MAX_OUTPUT_TOKENS)
            : SOVEREIGN_GROQ_MAX_OUTPUT_TOKENS,
        )
      : requestedTokenLimit;

    const safeMessages = isSovereignGroq
      ? compactSovereignGroqMessages(messages)
      : messages;

    const body: Record<string, unknown> = {
      model,
      messages: safeMessages.map(formatMessage),
      stream: false,
    };

    if (usesCompletionTokens) {
      body.max_completion_tokens = tokenLimit;
    } else {
      body.max_tokens = tokenLimit;
    }

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    if (backend === "anthropic") {
      return chatViaAnthropic({
        model,
        tokenLimit,
        messages,
        tools,
        temperature: opts?.temperature,
        anthropicApiKey: anthropicApiKey as string,
        httpClient,
      });
    }

    const openAiLikeApiUrl =
      backend === "openai" ? "https://api.openai.com" :
      backend === "groq" ? "https://api.groq.com/openai" :
      backend === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai" :
      backend === "ollama" ? (ollamaBaseUrl as string).replace(/\/$/, "") :
      apiUrl;
    const openAiLikeApiKey =
      backend === "openai" ? (openaiApiKey as string) :
      backend === "groq" ? (groqApiKey as string) :
      backend === "gemini" ? (geminiApiKey as string) :
      backend === "ollama" ? "ollama" :
      apiKey;

    if (backend === "groq") {
      await throttleGroq();
    }

    try {
      return await chatViaOpenAiCompatible({
        model,
        body,
        apiUrl: openAiLikeApiUrl,
        apiKey: openAiLikeApiKey,
        backend,
        httpClient,
        retries: process.env.RITTY_MODE === "sovereign" && (backend === "groq" || backend === "gemini")
          ? SOVEREIGN_PROVIDER_RETRIES
          : undefined,
      });
    } catch (error) {
      // Sovereign mode uses Groq as the primary path, but a provider outage or
      // quota exhaustion must not stop the entire agent. Fall back immediately
      // to Gemini when a Gemini key is configured; do not retry the same Groq
      // request because a 429/TPD failure will not recover by retrying.
      if (
        backend === "groq" &&
        process.env.RITTY_MODE === "sovereign" &&
        geminiApiKey
      ) {
        const groqMessage = error instanceof Error ? error.message : String(error);
        const fallbackModel = process.env.RITTY_GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";
        const fallbackBody: Record<string, unknown> = {
          ...body,
          model: fallbackModel,
          max_tokens: tokenLimit,
        };
        delete fallbackBody.max_completion_tokens;

        logger.warn(
          `[SOVEREIGN] Groq inference failed; switching to Gemini fallback (${fallbackModel}): ${groqMessage.slice(0, 300)}`,
        );

        try {
          return await chatViaOpenAiCompatible({
            model: fallbackModel,
            body: fallbackBody,
            apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            apiKey: geminiApiKey,
            backend: "gemini",
            httpClient,
            retries: SOVEREIGN_PROVIDER_RETRIES,
          });
        } catch (geminiError) {
          const geminiMessage =
            geminiError instanceof Error ? geminiError.message : String(geminiError);
          logger.error(
            `[SOVEREIGN] Gemini fallback also failed: ${geminiMessage.slice(0, 500)}`,
          );
          throw new Error(
            `Groq inference failed and Gemini fallback failed: ${geminiMessage}`,
          );
        }
      }

      throw error;
    }
  };

  /**
   * @deprecated Use InferenceRouter for tier-based model selection.
   * Still functional as a fallback; router takes priority when available.
   */
  const setLowComputeMode = (enabled: boolean): void => {
    if (enabled) {
      currentModel = options.lowComputeModel || "gpt-5-mini";
      maxTokens = 4096;
    } else {
      currentModel = options.defaultModel;
      maxTokens = options.maxTokens;
    }
  };

  const getDefaultModel = (): string => {
    return currentModel;
  };

  return {
    chat,
    setLowComputeMode,
    getDefaultModel,
  };
}

function formatMessage(
  msg: ChatMessage,
): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.name) formatted.name = msg.name;
  if (msg.tool_calls) formatted.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;

  return formatted;
}

/**
 * Resolve which backend to use for a model.
 * When InferenceRouter is available, it uses the model registry's provider field.
 * This function is kept for backward compatibility with direct inference calls.
 */
function resolveInferenceBackend(
  model: string,
  keys: {
    openaiApiKey?: string;
    anthropicApiKey?: string;
    ollamaBaseUrl?: string;
    groqApiKey?: string;
    geminiApiKey?: string;
    getModelProvider?: (modelId: string) => string | undefined;
  },
): InferenceBackend {
  // In sovereign RITTY mode, Conway registry records must never be allowed
  // to route a Groq model back to the retired Conway endpoint.
  if (process.env.RITTY_MODE === "sovereign" && keys.groqApiKey) {
    return "groq";
  }

  // Registry-based routing: most accurate, no name guessing
  if (keys.getModelProvider) {
    const provider = keys.getModelProvider(model);
    if (provider === "ollama" && keys.ollamaBaseUrl) return "ollama";
    if (provider === "anthropic" && keys.anthropicApiKey) return "anthropic";
    if (provider === "openai" && keys.openaiApiKey) return "openai";
    if (provider === "groq" && keys.groqApiKey) return "groq";
    if (provider === "gemini" && keys.geminiApiKey) return "gemini";
    if (provider === "conway") return "conway";
    // provider unknown or key not configured — fall through to heuristics
  }

  // Heuristic fallback (model not in registry yet)
  if (keys.anthropicApiKey && /^claude/i.test(model)) return "anthropic";
  if (keys.openaiApiKey && /^(gpt-[3-9]|gpt-4|gpt-5|o[1-9][-\s.]|o[1-9]$|chatgpt)/i.test(model)) return "openai";
  if (keys.groqApiKey && /^(llama-|mixtral|gemma|qwen)/i.test(model)) return "groq";
  if (keys.geminiApiKey && /^gemini-/i.test(model)) return "gemini";
  return "conway";

}

async function chatViaOpenAiCompatible(params: {
  model: string;
  body: Record<string, unknown>;
  apiUrl: string;
  apiKey: string;
  backend: "conway" | "openai" | "groq" | "gemini" | "ollama";
  httpClient: ResilientHttpClient;
  retries?: number;
  timeoutMs?: number;
}): Promise<InferenceResponse> {
  const endpoint =
    params.backend === "gemini"
      ? `${params.apiUrl}/chat/completions`
      : `${params.apiUrl}/v1/chat/completions`;

  const resp = await params.httpClient.request(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        params.backend === "openai" ||
        params.backend === "groq" ||
        params.backend === "gemini" ||
        params.backend === "ollama"
          ? `Bearer ${params.apiKey}`
          : params.apiKey,
    },
    body: JSON.stringify(params.body),
    timeout: INFERENCE_TIMEOUT_MS,
    ...(params.retries !== undefined ? { retries: params.retries } : {}),
    ...(params.timeoutMs !== undefined ? { timeout: params.timeoutMs } : {}),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Inference error (${params.backend}): ${resp.status}: ${text}`,
    );
  }

  const data = await resp.json() as any;
  const choice = data.choices?.[0];

  if (!choice) {
    throw new Error("No completion choice returned from inference");
  }

  const message = choice.message;
  const usage: TokenUsage = {
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
  };

  const toolCalls: InferenceToolCall[] | undefined =
    message.tool_calls?.map((tc: any) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

  return {
    id: data.id || "",
    model: data.model || params.model,
    message: {
      role: message.role,
      content: message.content || "",
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: choice.finish_reason || "stop",
  };
}

async function chatViaAnthropic(params: {
  model: string;
  tokenLimit: number;
  messages: ChatMessage[];
  tools?: InferenceToolDefinition[];
  temperature?: number;
  anthropicApiKey: string;
  httpClient: ResilientHttpClient;
}): Promise<InferenceResponse> {
  const transformed = transformMessagesForAnthropic(params.messages);
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.tokenLimit,
    messages:
      transformed.messages.length > 0
        ? transformed.messages
        : (() => { throw new Error("Cannot send empty message array to Anthropic API"); })(),
  };

  if (transformed.system) {
    body.system = transformed.system;
  }

  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    body.tool_choice = { type: "auto" };
  }

  const resp = await params.httpClient.request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": params.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    timeout: INFERENCE_TIMEOUT_MS,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Inference error (anthropic): ${resp.status}: ${text}`);
  }

  const data = await resp.json() as any;
  const content = Array.isArray(data.content) ? data.content : [];
  const textBlocks = content.filter((c: any) => c?.type === "text");
  const toolUseBlocks = content.filter((c: any) => c?.type === "tool_use");

  const toolCalls: InferenceToolCall[] | undefined =
    toolUseBlocks.length > 0
      ? toolUseBlocks.map((tool: any) => ({
          id: tool.id,
          type: "function" as const,
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.input || {}),
          },
        }))
      : undefined;

  const textContent = textBlocks
    .map((block: any) => String(block.text || ""))
    .join("\n")
    .trim();

  if (!textContent && !toolCalls?.length) {
    throw new Error("No completion content returned from anthropic inference");
  }

  const promptTokens = data.usage?.input_tokens || 0;
  const completionTokens = data.usage?.output_tokens || 0;
  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };

  return {
    id: data.id || "",
    model: data.model || params.model,
    message: {
      role: "assistant",
      content: textContent,
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: normalizeAnthropicFinishReason(data.stop_reason),
  };
}

function transformMessagesForAnthropic(
  messages: ChatMessage[],
): { system?: string; messages: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const transformed: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }

    if (msg.role === "user") {
      // Merge consecutive user messages
      const last = transformed[transformed.length - 1];
      if (last && last.role === "user" && typeof last.content === "string") {
        last.content = last.content + "\n" + msg.content;
        continue;
      }
      transformed.push({
        role: "user",
        content: msg.content,
      });
      continue;
    }

    if (msg.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      for (const toolCall of msg.tool_calls || []) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments),
        });
      }
      if (content.length === 0) {
        content.push({ type: "text", text: "" });
      }
      // Merge consecutive assistant messages
      const last = transformed[transformed.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.content)) {
        (last.content as Array<Record<string, unknown>>).push(...content);
        continue;
      }
      transformed.push({
        role: "assistant",
        content,
      });
      continue;
    }

    if (msg.role === "tool") {
      // Merge consecutive tool messages into a single user message
      // with multiple tool_result content blocks
      const toolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "unknown_tool_call",
        content: msg.content,
      };

      const last = transformed[transformed.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        // Append tool_result to existing user message with content blocks
        (last.content as Array<Record<string, unknown>>).push(toolResultBlock);
        continue;
      }

      transformed.push({
        role: "user",
        content: [toolResultBlock],
      });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: transformed,
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function normalizeAnthropicFinishReason(reason: unknown): string {
  if (typeof reason !== "string") return "stop";
  if (reason === "tool_use") return "tool_calls";
  return reason;
}
