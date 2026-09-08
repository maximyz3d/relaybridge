---
name: relaybridge-output-quality
description: Choose and verify RelayBridge output guidance for a delegated coding, planning, research, decision, collaboration or UI critique task. Use when a structured quality criterion would improve the requested deliverable, or when selecting a public workflow reference for that task.
---

# RelayBridge output quality

Keep the user's actual outcome, audience, constraints and requested length in
the original prompt. A profile supplies criteria, not a replacement task or
permission to perform more work.

When RelayBridge's current MCP tools are available:

1. Read `get_context_bundle` when taking over work. Resume its matching task or
   workflow; do not create a duplicate to obtain a cleaner conversation.
2. Read `list_output_profiles` and choose one relevant profile. Use the returned
   `{id, version, digest}` as `outputProfile` in `plan_task`; retain the returned
   execution tuple. Omit guidance when the original request already states the
   needed criteria or the answer is a single simple fact.
3. Execute within the existing authorization using `ask_provider`,
   `route_and_ask`, `run_committee`, `broadcast`, or `submit_task`. Send the
   original prompt with the same selector. Do not also send `preparedPrompt`:
   that ordinary compiled text already contains the guidance.
4. Judge the delivered artifact against the original request and selected
   criteria. Retain exact receipt/request identities and report missing
   evidence. A profile, completed task, successful plan or agreeing committee
   does not establish review approval, merge, deployment or correctness.

Choose by the deliverable: `code-debug` for a supported diagnosis/change;
`implementation-plan` for dependencies and acceptance; `research-synthesis`
for source-based conclusions; `decision-analysis` for tradeoffs;
`collaboration-synthesis` for independent findings and disagreement;
`design-critique` for user flows and observable interface friction. Read the
current text before choosing; profile identifiers alone are not content pins.

If the tools are unavailable, apply only the useful criteria directly to your
answer and say no bridge execution occurred. Do not fabricate tool results.
There is no dedicated CLI profile flag or automatic workflow-phase selector.

Use `list_workflow_library` when a task would benefit from a skill or MCP
reference. Inspect its pinned source, file-specific license and trust notes.
`available_not_connected` means discovery only. An entry cannot grant tool
access, change credentials or authorize installation; actual connections need
their own runtime evidence and the user's existing task authorization.
