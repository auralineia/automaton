/**
 * RITTY Sovereign Runtime Client
 *
 * Conway-compatible control-plane surface backed by the local Railway
 * container. It preserves the Automaton's client contract without requiring
 * Conway credentials. Remote financial/domain operations are deliberately
 * unavailable instead of being faked.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type {
  ConwayClient,
  ExecResult,
  PortInfo,
  CreateSandboxOptions,
  SandboxInfo,
  PricingTier,
  CreditTransferResult,
  DomainSearchResult,
  DomainRegistration,
  DnsRecord,
  ModelInfo,
} from "../types.js";

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME || "/root";
const ROOT_DIR = path.join(HOME, ".automaton");
const SANDBOX_DIR = path.join(ROOT_DIR, "sandboxes");
const STATE_FILE = path.join(ROOT_DIR, "sovereign-runtime.json");
const DEFAULT_CREDITS_CENTS = 100_000;

interface SovereignState {
  creditsCents: number;
  createdAt: string;
  identity?: Record<string, unknown>;
  domains?: Record<string, DomainRegistration>;
}

function ensureDirs(): void {
  fs.mkdirSync(ROOT_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SANDBOX_DIR, { recursive: true, mode: 0o700 });
}

function loadState(): SovereignState {
  ensureDirs();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as SovereignState;
    return {
      creditsCents:
        Number.isFinite(parsed.creditsCents) && parsed.creditsCents >= 0
          ? parsed.creditsCents
          : DEFAULT_CREDITS_CENTS,
      createdAt: parsed.createdAt || new Date().toISOString(),
      identity: parsed.identity,
      domains: parsed.domains || {},
    };
  } catch {
    return {
      creditsCents: Number.isFinite(Number(process.env.RITTY_LOCAL_CREDITS_CENTS))
        ? Math.max(0, Number(process.env.RITTY_LOCAL_CREDITS_CENTS))
        : DEFAULT_CREDITS_CENTS,
      createdAt: new Date().toISOString(),
      domains: {},
    };
  }
}

function saveState(state: SovereignState): void {
  ensureDirs();
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );
}

function normalizePath(filePath: string, baseDir: string): string {
  const expanded = filePath.startsWith("~")
    ? path.join(HOME, filePath.slice(1))
    : filePath;
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseDir, expanded);
}

function ensureInsideRoot(target: string): void {
  const resolved = path.resolve(target);
  const root = path.resolve(HOME);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes runtime root: ${target}`);
  }
}

function sandboxRoot(sandboxId: string): string {
  const safeId = sandboxId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(SANDBOX_DIR, safeId);
  ensureInsideRoot(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function runShell(command: string, cwd: string, timeoutMs = 30_000): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      ["-lc", command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
      },
    );
    return {
      stdout: stdout || "",
      stderr: stderr || "",
      exitCode: 0,
    };
  } catch (error: any) {
    return {
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || error?.message || ""),
      exitCode: typeof error?.code === "number" ? error.code : 1,
    };
  }
}

function localSandboxInfo(id: string, status = "running"): SandboxInfo {
  const dir = sandboxRoot(id);
  return {
    id,
    status,
    region: process.env.RAILWAY_REGION || "railway-local",
    vcpu: Number(process.env.RITTY_SANDBOX_VCPU || 1),
    memoryMb: Number(process.env.RITTY_SANDBOX_MEMORY_MB || 1024),
    diskGb: Number(process.env.RITTY_SANDBOX_DISK_GB || 10),
    terminalUrl: undefined,
    createdAt: fs.statSync(dir).birthtime.toISOString(),
  };
}

export function createSovereignClient(sandboxId = "local-root"): ConwayClient {
  ensureDirs();
  const state = loadState();
  saveState(state);

  const ownSandboxId = sandboxId || "local-root";

  const exec = async (command: string, timeout?: number): Promise<ExecResult> => {
    const cwd = ownSandboxId === "local-root" ? HOME : sandboxRoot(ownSandboxId);
    return runShell(command, cwd, timeout ?? 30_000);
  };

  const writeFile = async (filePath: string, content: string): Promise<void> => {
    const baseDir = ownSandboxId === "local-root" ? HOME : sandboxRoot(ownSandboxId);
    const resolved = normalizePath(filePath, baseDir);
    ensureInsideRoot(resolved);
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    fs.writeFileSync(resolved, content, { encoding: "utf-8", mode: 0o600 });
  };

  const readFile = async (filePath: string): Promise<string> => {
    const baseDir = ownSandboxId === "local-root" ? HOME : sandboxRoot(ownSandboxId);
    const resolved = normalizePath(filePath, baseDir);
    ensureInsideRoot(resolved);
    return fs.readFileSync(resolved, "utf-8");
  };

  const exposePort = async (port: number): Promise<PortInfo> => ({
    port,
    publicUrl: `http://127.0.0.1:${port}`,
    sandboxId: ownSandboxId,
  });

  const removePort = async (_port: number): Promise<void> => {};

  const createSandbox = async (options: CreateSandboxOptions): Promise<SandboxInfo> => {
    const id = `local-${randomUUID()}`;
    const dir = sandboxRoot(id);
    fs.writeFileSync(
      path.join(dir, "sandbox.json"),
      JSON.stringify({
        id,
        name: options.name || id,
        vcpu: options.vcpu || 1,
        memoryMb: options.memoryMb || 512,
        diskGb: options.diskGb || 5,
        createdAt: new Date().toISOString(),
      }, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
    return localSandboxInfo(id);
  };

  const deleteSandbox = async (targetId: string): Promise<void> => {
    if (!targetId || targetId === "local-root") {
      return;
    }
    const dir = sandboxRoot(targetId);
    fs.rmSync(dir, { recursive: true, force: true });
  };

  const listSandboxes = async (): Promise<SandboxInfo[]> => {
    ensureDirs();
    return fs.readdirSync(SANDBOX_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const id = entry.name;
        try {
          return localSandboxInfo(id);
        } catch {
          return null;
        }
      })
      .filter((item): item is SandboxInfo => item !== null);
  };

  const getCreditsBalance = async (): Promise<number> => {
    const current = loadState();
    return current.creditsCents;
  };

  const getCreditsPricing = async (): Promise<PricingTier[]> => ([
    { name: "local-small", vcpu: 1, memoryMb: 512, diskGb: 5, monthlyCents: 0 },
    { name: "local-standard", vcpu: 1, memoryMb: 1024, diskGb: 10, monthlyCents: 0 },
    { name: "local-large", vcpu: 2, memoryMb: 2048, diskGb: 20, monthlyCents: 0 },
  ]);

  const transferCredits = async (
    _toAddress: string,
    _amountCents: number,
    _note?: string,
  ): Promise<CreditTransferResult> => {
    throw new Error(
      "Credit transfers are disabled in RITTY sovereign mode because there is no Conway credit ledger. No funds were moved.",
    );
  };

  const registerAutomaton = async (params: {
    automatonId: string;
    automatonAddress: string;
    creatorAddress: string;
    name: string;
    bio?: string;
    genesisPromptHash?: `0x${string}`;
  }): Promise<{ automaton: Record<string, unknown> }> => {
    const current = loadState();
    current.identity = {
      automatonId: params.automatonId,
      automatonAddress: params.automatonAddress,
      creatorAddress: params.creatorAddress,
      name: params.name,
      bio: params.bio || "",
      genesisPromptHash: params.genesisPromptHash,
      registeredAt: new Date().toISOString(),
      registry: "local-sovereign",
    };
    saveState(current);
    return { automaton: current.identity };
  };

  const searchDomains = async (
    query: string,
    tlds?: string,
  ): Promise<DomainSearchResult[]> => {
    if (!query.trim()) return [];
    const wanted = (tlds || ".com,.io,.ai").split(",").map((v) => v.trim()).filter(Boolean);
    return wanted.slice(0, 10).map((suffix) => ({
      domain: query.toLowerCase().replace(/[^a-z0-9-]/g, "") + (suffix.startsWith(".") ? suffix : `.${suffix}`),
      available: false,
      currency: "USD",
    }));
  };

  const registerDomain = async (
    domain: string,
    years = 1,
  ): Promise<DomainRegistration> => {
    throw new Error(
      `Domain registration for ${domain} (${years} year${years === 1 ? "" : "s"}) is unavailable in sovereign mode. No purchase was attempted.`,
    );
  };

  const listDnsRecords = async (_domain: string): Promise<DnsRecord[]> => [];

  const addDnsRecord = async (
    _domain: string,
    _type: string,
    _host: string,
    _value: string,
    _ttl?: number,
  ): Promise<DnsRecord> => {
    throw new Error("DNS changes are unavailable in sovereign mode. No external DNS was modified.");
  };

  const deleteDnsRecord = async (_domain: string, _recordId: string): Promise<void> => {
    throw new Error("DNS changes are unavailable in sovereign mode. No external DNS was modified.");
  };

  const listModels = async (): Promise<ModelInfo[]> => ([
    {
      id: "llama-3.3-70b-versatile",
      provider: "groq",
      pricing: { inputPerMillion: 0.2, outputPerMillion: 0.2 },
    },
    {
      id: "llama-3.1-8b-instant",
      provider: "groq",
      pricing: { inputPerMillion: 0.05, outputPerMillion: 0.08 },
    },
  ]);

  const createScopedClient = (targetSandboxId: string): ConwayClient =>
    createSovereignClient(targetSandboxId);

  return {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort,
    createSandbox,
    deleteSandbox,
    listSandboxes,
    getCreditsBalance,
    getCreditsPricing,
    transferCredits,
    registerAutomaton,
    searchDomains,
    registerDomain,
    listDnsRecords,
    addDnsRecord,
    deleteDnsRecord,
    listModels,
    createScopedClient,
  };
}
