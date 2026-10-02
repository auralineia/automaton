# RITTY Conway Compatibility Layer — Migration Contract

Status: discovery / design only. No runtime behavior is changed by this document.

## Objective

Preserve the Automaton runtime's agent loop, policy engine, memory, heartbeat, self-modification, replication, identity model, tool contracts, and observability while replacing Conway-hosted services with explicitly configured providers. This is a compatibility migration, not a rewrite of the agent.

"Feature parity" is an acceptance target, not an assumption. A capability is not considered replaced until an adapter implements its contract and automated tests verify behavior and failure modes.

## Runtime areas requiring adapters

| Existing contract | Required replacement behavior | Candidate implementation |
|---|---|---|
| Inference / model listing | Chat completions, tool calls, usage, model selection and failure semantics | Existing provider registry + Groq/OpenAI-compatible API |
| Sandbox exec, file I/O, ports | Isolated command execution, files, public port lifecycle, timeouts and nonzero exit results | E2B or separately provisioned isolated worker; Railway is runtime hosting, not automatically a per-agent sandbox |
| Sandbox create/list/delete | Provision, enumerate, lifecycle and resource reporting | Provider-specific adapter; Railway API or sandbox provider, subject to API and cost review |
| Credits, pricing, transfers | Accurate balance/usage ledger, pricing, transfers and idempotency | Local accounting ledger first; no fabricated provider balance |
| x402/top-ups | Payment request verification, supported chain and explicit approval | Disabled until independently implemented, tested and explicitly authorized |
| Domain/DNS | Availability search, registration, DNS CRUD and renewal/error reporting | External registrar/DNS APIs |
| SIWE provisioning / API key | Non-Conway authentication and credential lifecycle | Local service identity; no fake Conway key or Conway registration |
| ERC-8004 identity | Preserve wallet identity and chain-specific signing/registration | Existing wallet/registry modules, verify network and contract support |
| Social relay | Message transport, signatures, validation, inbox semantics | Replace relay transport while retaining protocol and validation contracts |
| Bootstrap and survival | Honest cost/balance signals, low-compute behavior and stopped state | Provider usage metering and a truthful local ledger |

## Design constraints

1. Keep the original agent decision loop and policy rules unchanged unless a test proves an adapter contract cannot be met otherwise.
2. Put provider selection behind interfaces/factories. Do not scatter provider-specific conditionals throughout the agent.
3. Fail closed: unavailable balance, sandbox, identity, or payment status must be reported as unavailable, never as a successful fake result.
4. Never silently run a command locally when a configured remote sandbox fails; local execution changes the security boundary.
5. No automatic USDC transfer, credit purchase, child funding, paid service creation, or domain purchase during boot or tests. Financial actions require a separate explicit approval path and a hard spending cap.
6. Preserve secrets in Railway variables or private runtime files with restrictive permissions. Never commit keys, private keys, wallet files, or live state.
7. Preserve state compatibility and provide backup/rollback before any database migration.
8. Add contract tests for success, timeout, retry, authentication failure, idempotency, partial failure, and provider outage.

## Required verification before deployment

- Baseline build, typecheck and full test suite on the untouched upstream commit.
- Adapter contract tests for every ConwayClient operation used by tools, heartbeat, survival, replication and CLI.
- End-to-end tests for agent loop, memory persistence, heartbeat restart, tool calls, self-mod audit trail, replication lifecycle, and identity.
- Security tests proving sandbox isolation and no fallback to host execution.
- Financial tests proving no spend or transfer occurs without approval.
- Restart/redeploy test with persistent storage and state recovery.
- Measured inference latency, token usage, CPU/RAM, retry behavior and cost compared with baseline.

## Current known blocker

The entry point requires a Conway API key and initializes Conway-backed registration, credits and service clients. Setting a Groq key alone is not sufficient. The original README also describes local execution when sandboxId is empty, but that does not replace every control-plane capability. Therefore removing the API-key check alone would not deliver feature parity.

## Rollout

Work only on a dedicated migration branch. Keep the current deployment and original branch untouched. Implement and verify one adapter at a time; do not switch Railway's production branch until all required capabilities pass the acceptance checks.