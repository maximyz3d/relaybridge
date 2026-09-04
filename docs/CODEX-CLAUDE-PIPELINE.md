# Codex-Claude pipeline

This profile makes Codex the user-facing orchestrator and primary implementation
writer. Claude contributes a fresh read-only plan, fresh initial and final
read-only reviews, and a bounded Sonnet revision when a review requests changes,
after an explicit writer-lease transfer.

## Install

Use current Codex and Claude Code releases; Claude Code 2.1.257 or later is the
recommended baseline for the restricted/Fable feature set.

For the intended WSL deployment, clone RelayBridge beneath the Linux home
filesystem and run from that checkout:

```bash
./install-skill.sh --register-mcp --register-chrome --full-permissions
./start-chrome-debug.sh
```

This is the recommended setup for this owner-requested auto/full-permission
profile. To omit browser automation, leave out `--register-chrome`. To retain
the safe-reset default, also omit `--full-permissions`. The equivalent split
installation is:

```bash
./install-skill.sh
./install-mcp.sh --full-permissions
./install-chrome-mcp.sh --full-permissions
```

`install-mcp.sh` resolves `mcp/server.mjs` from the checkout containing the
script, creates or validates a mode-0600 capability-token file without printing
the token, snapshots both client configurations, registers the exact server
path with both CLIs, derives Codex `tool_timeout_sec` from the repository timeout
policy, and verifies the resulting registrations. A partial failure restores
the snapshots.

The owner of this deployment explicitly requested persistent auto/full-
permission operation, so the command above opts in with `--full-permissions`.
That flag adds both the sticky and start-full variables to the RelayBridge MCP
process environments and sets the Codex MCP approval policy to `approve` for
the registered servers. It remains off by default for general users; omitting
the flag makes browser Full Permissions reset off after a restart.

Those two MCP environment gates also define the default for newly created MCP
pipelines. If `start_codex_claude_pipeline` omits both `permissionMode` and
`acknowledgeFilesystemWrites`, the handler atomically supplies `full` and
`true`. If either field is explicitly supplied, the shortcut is disabled:
`full` alone and `true` alone remain incomplete and are rejected downstream.
Explicit `safe`/`false` selects a safe workflow. Direct REST creation does not
use this MCP convenience; an omitted REST pair remains `safe`/`false`. The
resolved values are persisted on the new workflow and never retrofit an
existing one.

`install-skill.sh` links the pipeline skill into `~/.agents/skills`, the
compatibility location `~/.codex/skills`, and `~/.claude/skills`, and links the
role files into the two clients' user agent directories. An existing target is
moved to a timestamped backup first. Restart open clients after installation.
The RelayBridge and Chrome MCP registrations are user-scoped as well (Claude is
registered with `--scope user`; Codex writes its user configuration). The links
and MCP commands resolve this exact checkout, so rerun the installer after
moving it.

Sign into each local CLI directly. The installers do not read or print provider
credentials:

```bash
codex login
claude auth login
```

Anthropic's authentication rules do not allow a third-party bridge to collect
or proxy a user's Claude subscription credentials. RelayBridge starts the
user's own installed CLI instead. See [Claude authentication](https://code.claude.com/docs/en/authentication)
and [Codex authentication](https://learn.chatgpt.com/docs/auth.md).

### WSL-native runtime with a Windows Chrome boundary

Keep the checkout, RelayBridge data/token/config, Node, npm/npx, Codex, and
Claude under the WSL Linux filesystem. `install-skill.sh` refuses a checkout
under `/mnt`; `install-mcp.sh` also refuses Windows Node resolved through
`/mnt`, and `install-chrome-mcp.sh` refuses Windows npx. At runtime the bridge
fails closed if its checkout, data, token, config, or Node path is on `/mnt`.
This avoids slow metadata access and ambiguous Windows/Linux executable and
path resolution. `RELAYBRIDGE_ALLOW_SLOW_WSL_FS=1` exists as an explicit server
diagnostic override, but it does not make the POSIX installers accept a mixed
runtime. Install native Linux provider CLIs rather than selecting Windows
provider binaries through interop.

`start-chrome-debug.sh` is the deliberate GUI exception: from WSL it invokes
`powershell.exe` to launch Windows Chrome while the MCP server and both AI CLIs
remain Linux-native. Chrome uses the dedicated persistent profile
`%LOCALAPPDATA%\RelayBridge\ChromeDevToolsProfile` and exposes DevTools only at
`http://127.0.0.1:9222`. Mirrored networking uses that loopback path directly.
When WSL is in NAT mode, the launcher automatically uses Linux-native `socat`
on WSL loopback plus a Windows-Node helper bound only to the verified Hyper-V
WSL adapter on a separate high port. The helper allow-lists this distro's current
private IP, targets only Chrome's Windows loopback, and never changes firewall
policy. The fallback requires both Linux `socat` and Windows `node.exe`. The
registration pins `chrome-devtools-mcp` and defaults to its token-efficient slim
mode.

Slim mode supplies the normal navigation, page-evaluation, and screenshot
tools. If a bounded task needs the console, network, or performance families,
replace the registration with the full tool surface and restart Codex and
Claude:

```bash
./install-chrome-mcp.sh --full-tools --full-permissions
```

DevTools access is full browser control, not a sandbox or authentication
mechanism. Never bind either hop to wildcard, LAN, VPN, or internet addresses;
do not add broad firewall exceptions. Prefer mirrored networking when available.
Avoid sensitive personal sessions in the automation profile, and close the
dedicated Chrome when the task is done. Its separate profile prevents accidental
reuse of the normal Chrome profile, but it may retain its own cookies, history,
and site data between launches.

## Phase protocol

Every run has one pipeline ID and one compact canonical packet. At the start of
every new or resumed Codex session, call `list_pipelines` before creating work.
Match active entries by canonical workspace, objective, and phase. When a
matching run exists, call `get_pipeline` with its `runId`, load its bounded
artifacts, and obey the returned `nextActions`; do not create a replacement.
Durable workflow state is the source of truth after a chat restart, context
compaction, disconnect, or out-of-order provider completion.

Use the MCP workflow in this order:

1. After `list_pipelines` confirms there is no matching active run, call
   `start_codex_claude_pipeline` exactly once with the bounded objective,
   constraints, non-goals, file scope, base revision, and acceptance checks.
   For any workflow that may use the Claude reviser, the resolved workflow pair
   must be `permissionMode:"full"` and
   `acknowledgeFilesystemWrites:true`. With the recommended full-permission MCP
   registration, omitting both fields supplies that pair atomically; sending
   the pair explicitly is clearer in portable prompts and is required for raw
   REST clients.
2. Run independent Codex research lanes only when they are read-only and
   non-overlapping. Consolidate them with `submit_pipeline_research`.
3. Read with `get_pipeline`, then use `reconcile_pipeline` when its
   `nextActions` names that operation until planning reaches `plan_ready`.
   Reconciliation settles a completed provider task exactly once. A slow active phase is
   not permission to launch a duplicate. Typed transient failures in read-only
   planning/review phases remain in the same phase and retry at most three
   total attempts with durable backoff. Semantic failures and every writer
   failure still fail closed.
4. After accepting the Claude plan, call `claim_pipeline_implementation`.
   Codex is now the only writer. Use `renew_pipeline_writer_lease` before an
   active lease expires.
5. Call `complete_pipeline_implementation` with the resulting revision, exact
   changed-file list, and verification evidence. The lease must be released
   before review starts.
6. Review in a fresh Sonnet read-only session. If it requests changes, call
   `start_pipeline_revision`; only the `pipeline-reviser` may hold that writer
   lease, and only for those accepted findings.
7. Call `start_pipeline_final_review` after revisions (or after an approved
   initial review). This actual closing gate is a fresh read-only Claude
   Sonnet/high review. A Codex verifier may run focused supplementary checks,
   but does not replace Claude's final-review verdict. Close only when the
   acceptance checks and all material findings are resolved.
8. Call `cancel_pipeline` for an intentional stop. Do not record a cancellation,
   timeout, or promise of later work as successful completion.

Read status with `get_pipeline` and advance only with `reconcile_pipeline` when
named by `nextActions`; do not infer state from the newest receipt. Preserve
each direct `requestId`/`invocationId`/`receiptId` tuple because concurrent runs
can complete out of order.

Safe workflows resolve to `permissionMode:"safe"` with
`acknowledgeFilesystemWrites:false`. Full workflows are valid only with both
`permissionMode:"full"` and `acknowledgeFilesystemWrites:true`; either
mismatched combination is rejected. Under the recommended full-permission MCP
registration, omission of the entire pair resolves atomically to full/true;
without both registration gates, and for direct REST, total omission resolves
to safe/false. The full pair makes the bounded Claude revision phase eligible,
but it neither starts that phase nor bypasses its review decision and
writer-lease gates.

### MCP and REST phase mapping

MCP is the preferred agent interface; REST exposes the same durable state
machine to authenticated operator clients. `get_pipeline`/the workflow GET is
strictly side-effect free. Provider settlement, persisted-handoff repair, and
due retry dispatch use the identity-gated `reconcile_pipeline` POST, so a stale
status client cannot spend provider quota.

| MCP tool | REST operation | Required state and effect |
|---|---|---|
| `list_pipelines` | `GET /api/workflows` | Any time; list first to find resumable or conflicting work. |
| `get_pipeline` | `GET /api/workflows/:runId` | Any phase; read current state, artifacts, and `nextActions` without dispatching or settling work. |
| `reconcile_pipeline` | `POST /api/workflows/:runId/reconcile` | A handoff or active provider phase; identity-gated settlement, crash recovery, or due read-only retry dispatch. |
| `start_codex_claude_pipeline` | `POST /api/workflows` | Create one `scoping` workflow after the duplicate check. |
| `submit_pipeline_research` | `POST /api/workflows/:runId/research` | `scoping` → queued `planning` through the internal `research_ready` gate. |
| `claim_pipeline_implementation` | `POST /api/workflows/:runId/implementation/claim` | `plan_ready` → `implementing`; return the exclusive lease token. |
| `renew_pipeline_writer_lease` | `POST /api/workflows/:runId/lease/renew` | Extend the live Codex implementation lease; ownership does not change. |
| `complete_pipeline_implementation` | `POST /api/workflows/:runId/implementation/complete` | Valid lease: release it and queue `reviewing` through `implementation_ready`. |
| `start_pipeline_revision` | `POST /api/workflows/:runId/revision/start` | `review_ready` with requested changes and a full+ack workflow → exclusive Claude `revising`. |
| `start_pipeline_final_review` | `POST /api/workflows/:runId/final-review/start` | Approved `review_ready`, or `revision_ready`, → fresh `final_reviewing`; result is `complete` or returns to `review_ready`. |
| `retry_failed_pipeline_provider` | `POST /api/workflows/:runId/provider/retry` | Recover an older terminal workflow only when its last read-only task has durable typed transient-failure evidence; the same three-attempt ceiling applies. |
| `cancel_pipeline` | `POST /api/workflows/:runId/cancel` | Cancel nonterminal work; a running Claude writer must exit before its lease can be released. |

REST calls require the RelayBridge capability token. Treat the returned
`nextActions` as authoritative rather than manually forcing a transition.

The canonical handoff packet should remain bounded:

```json
{
  "pipelineId": "opaque-id",
  "objective": "one outcome",
  "constraints": [],
  "nonGoals": [],
  "fileScope": [],
  "baseRevision": "git object id",
  "decisions": [],
  "acceptanceChecks": [],
  "risks": [],
  "evidence": [],
  "artifacts": [],
  "writerLease": null
}
```

Transfer this packet and targeted evidence, not entire chats, logs, or source
trees.

Rate limits, provider timeouts, and overloads are retryable only after the prior
read-only task is terminal. Retry timing uses the exact deadline committed by
the shared cooldown store, and the next attempt number is persisted in
`providerRetry`; status reads never dispatch, and reconciliation before
`retryAt` does not spend quota. At
attempt three the workflow becomes failed.
`retry_failed_pipeline_provider` exists for runs terminalized by older bridge
versions and refuses recovery without a matching durable task record and typed
transient evidence. A bridge-restart interruption also requires this explicit
action because the replacement cannot safely be automatic until the caller has
confirmed the former provider process is gone. Writer tasks are never retried.

## Roles and models

| Phase | Owner | Default model/effort | Filesystem |
|---|---|---|---|
| Research/scout | Codex subagent | Luna or Terra / medium | read-only |
| Standard plan | Claude planner | Sonnet / medium | read-only |
| Complex plan | Claude planner | Opus / high | read-only |
| Hardest plan | Claude planner | Fable heavy tier / high | read-only |
| Implementation | primary Codex | routed Codex tier | single writer lease |
| Initial review | Claude reviewer | Sonnet / high | read-only, fresh session |
| Accepted revision | Claude reviser | Sonnet / medium | single writer lease |
| Final review | Claude final reviewer | Sonnet / high | read-only, fresh session |
| Supplementary verification | Codex verifier | Terra / high | read-only |

Fable intentionally has no dangerous provider slot. All Claude writes use
`kind=claude`, whose baseline writer is Sonnet/medium, so the receipt and route
metadata identify the model family actually invoked. Model tiers remain
operator-selectable for safe work. Claude aliases float; pin a full model ID in
CI when reproducibility is more important than automatic upgrades. See
[Claude model configuration](https://code.claude.com/docs/en/model-config) and
[Codex model guidance](https://learn.chatgpt.com/docs/models.md).

Project Codex defaults cap spawned threads at six, use Terra/medium for ordinary
read-heavy subagents, compact at 120,000 total active-context tokens, and cap
project-instruction ingestion at 32 KiB. The scout explicitly uses Luna. Higher
parallelism costs more context, so six is a ceiling, not a target. See
[Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md).

## Provider isolation

Safe Claude and Fable one-shots retain newline-delimited `stream-json` output
and use this effective boundary:

```text
--safe-mode
--restricted
--strict-mcp-config
--mcp-config {"mcpServers":{}}
--tools Read,Glob,Grep
--permission-mode plan
--no-session-persistence
--autocompact 150k
```

`--restricted` removes command/code execution and WebFetch unless explicitly
reintroduced, confines file tools to working directories, loads no user/project
settings, and refuses bypass-permissions mode. `--safe-mode` disables project
and user customizations. Therefore one-shot prompts must state the phase role
and output contract directly; they do not inherit this repository's
`CLAUDE.md`, skill, agents, hooks, or MCP configuration. See the
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

The Claude writer deliberately omits `--restricted`, exposes only
`Read,Glob,Grep,Edit,Write,Bash`, and uses:

```text
--safe-mode --strict-mcp-config --mcp-config {"mcpServers":{}}
--no-session-persistence --autocompact 150k
--model sonnet --effort medium --dangerously-skip-permissions
```

It can modify the checkout and execute Bash, so it is eligible only after an
explicit full+ack workflow creation, an accepted review finding, and
writer-lease transfer. Run it in an isolated trusted environment.

Safe Codex one-shots use:

```text
codex exec --sandbox read-only --ignore-user-config --ignore-rules --ephemeral
```

The dangerous Codex slot also ignores user config and rules and is ephemeral,
which prevents a delegated child from inheriting the user's RelayBridge MCP and
recursively dispatching itself. It retains the explicit dangerous bypass and
must run only while it owns the writer lease. See [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md)
and [agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security.md).

Claude supports `xhigh` and `max` where the chosen model permits them. Normal
Codex CLI configuration supports through `xhigh`, so RelayBridge maps an
explicit cross-provider `max` request to `xhigh`; it never silently downgrades
that request to `high`.

## Auto versus full permissions

“Auto” and “full permissions” are different controls:

- Claude `--permission-mode auto` asks a classifier whether individual actions
  are safe. It is not unrestricted access.
- Claude `--permission-mode bypassPermissions` or
  `--dangerously-skip-permissions` skips permission prompts. Restricted mode
  refuses this setting.
- Codex's local Auto preset is a workspace-write sandbox with on-request
  approval. `--dangerously-bypass-approvals-and-sandbox` removes both boundaries.

RelayBridge never converts a failed safe call into a full-permission retry.
Ordinary provider calls require explicit `dangerous:true` plus their
filesystem-write acknowledgement. The staged workflow instead uses the
full/true permission pair persisted at creation; the recommended MCP installer
may inject that pair only when both request fields were omitted. Either route
still requires the writer lease, bounded file scope, and a trusted container,
VM, or equivalent host boundary. See [Claude permission modes](https://code.claude.com/docs/en/permission-modes)
and [Codex permissions](https://learn.chatgpt.com/docs/permission-modes.md).

## Context and non-overlap

Start new non-persistent Claude sessions for planning and review. Do not resume
the planner as the reviewer. For a continuing coordination thread, compact near
60–70% context use and retain only current decisions, file scope, artifact IDs,
risks, writer state, and verification status. Automated Claude provider calls
also use a 150k auto-compact window. See [Claude context windows](https://code.claude.com/docs/en/context-window)
and [Claude sessions](https://code.claude.com/docs/en/sessions).

Only read-only lanes may fan out. Two agents must never write the same checkout
or overlapping file scope. A separate session is not filesystem isolation. The
pipeline reviser intentionally operates in the canonical workflow checkout so
its changes are part of the implementation being finalized; do not add an
implicit worktree. It may start only after Codex releases the canonical writer
lease, and Codex must not resume writing until the Claude writer has exited and
the pipeline advances out of `revising`.

## Local security boundary

RelayBridge listens on `127.0.0.1`, but loopback alone is not authentication.
The capability token authorizes REST, WebSocket, and MCP actions. Keep
`.bridge-token` mode 0600, never put its value in arguments, prompts, logs, or
documentation, and never expose the listener through a public tunnel or reverse
proxy. The MCP registration stores only the token-file path. Another process
running as the same operating-system user may still be able to read that file,
so use a separate account/container when local processes are not mutually
trusted.

The MCP installers configure Codex's tool timeout to cover the maximum provider
run plus transport grace. Re-run the applicable installer after changing
`config/timeout-policy.json`. See [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp.md)
and [Claude MCP configuration](https://code.claude.com/docs/en/mcp).
