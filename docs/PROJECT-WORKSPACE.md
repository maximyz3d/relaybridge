# Project chat workspace

RelayBridge opens a project conversation at `/` or `/control-center.html`. The terminal dashboard and existing provider, workflow, and account tools remain at `/terminal` and `/index.html`. Both pages use the existing capability authentication and content security policy. The chat has external, local CSS and JavaScript, with no external font or script requests.

Create a project with its existing workspace folder, choose a senior advisor, and start a conversation. Messages and manually added tasks are stored before execution. Codex uses the configured `standard` tier at `medium` effort; the advisor uses its own provider's `heavy` tier at `high` effort. Missing or mismatched model controls produce an actionable error. No particular version is hardcoded by this UI.

The coordinator can respond, consult an advisor, or allocate up to four bounded tasks. An advisor result must have a complete, persisted delivery record and must return to another Codex turn before dependent tasks are allocated. Worker, advisor, and coordinator requests all use the existing safe queue, provider controls, workspace identity, account binding, and usage admission. Model text cannot enable writes or change those controls.

Read-only tasks run automatically. Coding tasks enter an existing reviewed workflow. A project may explicitly allow changes through that workflow when it is created; the default is read-only. An accepted plan and an external agent holding the exclusive writer lease are still required. **Ready for writer means waiting for that agent, not that code is being written.** Open Advanced tools to continue the workflow using its normal phase actions. A completed read-only task is a result from that task, not verification that the whole project is implemented or shipped.

## Persistence and recovery

`DATA_DIR/project-workspace/workspace.json` holds versioned projects, threads, messages, tasks, pending dispatch intents, and an action ledger. Atomic writes include the exact task identity and complete intent before the queue is called. The queue's existing durable delivery contract supplies a second layer of deduplication and verifies result integrity. A read never dispatches or settles provider work.

All mutations under `/api/project-workspace/` require a caller-generated `actionId` (8–100 letters, digits, underscores or hyphens). Repeating the same action and payload returns its original references; reusing it for different intent returns 409. Routes are `POST projects`, `threads`, `messages`, `tasks`, `resume`, and `resume-task`; `GET state` accepts optional `projectId` and `threadId`. Legacy project and collaboration APIs retain their existing formats. The new project store does not rewrite old collaboration history.

The browser retains the exact pending submission after an ambiguous network failure. Retry recovers that action instead of starting a different task. A restart resumes a saved, not-yet-submitted intent using the same task ID. A diagnosed submission error requires explicit Resume/Retry; an existing conflicting or physically uncertain execution remains blocked. Unknown, partial, unavailable, and unverified results never count as completed advisor evidence.

Limits are explicit: 64 projects, 100 conversations per project, 500 messages per conversation, 200 tasks per project, 4,000 action identities, and 3.5 MB of serialized project state. Individual messages and task instructions have a 12,000-character limit. A prompt exceeding the complete-input bound stops and asks for a new conversation rather than silently dropping prior instructions. A corrupt or full store is preserved and becomes unavailable for mutation; the UI never silently creates a replacement history. Unsent drafts and the last selection are local browser data; the conversation itself is server data.

## Activity and allowance

Activity is matched using the exact `queued:<taskId>` request identity. The UI shows real phases, elapsed time and fresh native usage when available. Missing or stale allowance displays “Usage not reported.” There is no estimated completion percentage. Global usage protection, the 2–5% reserve, automatic continuity handoffs, and dynamic supervision settings are available in Workspace settings.

Project chat checkpoints are durable before each dispatch and can be downloaded with **Save conversation handoff**. Its Codex coordinator pauses at the protected reserve and can resume when capacity is available. Automatic provider ownership transfer continues to belong to the existing managed continuity protocol; this UI does not silently transfer a Codex project conversation or grant a successor a writer lease.

## Verification

Unit tests cover action replay/conflicts, complete advisor evidence, routing tiers, quota pauses, absent-task recovery, state corruption, and project isolation. Integration tests use real bridge/queue/workflow code with disposable Node fixture providers; they exercise the complete Codex → senior advisor → Codex → worker path, exact delivery receipts, allowed workspace enforcement and protected HTML routes. They spend no native model allowance. Browser evidence covers desktop/mobile creation, chat, tasks, draft/reload recovery, errors and theme/navigation. Native-provider availability remains account dependent and is never inferred from fixture results.
