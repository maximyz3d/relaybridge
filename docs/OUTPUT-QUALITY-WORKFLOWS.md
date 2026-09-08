# Output guidance and workflow discovery

RelayBridge can append selected output criteria to a task before validating
and executing it. The original request still controls scope, audience and
length. The six locally authored profiles cover coding/debugging, planning,
research, decisions, collaboration and UI critique. They are optional; calls
without a selection preserve their existing prompt bytes and cache behavior.

## Use a profile

In **Background tasks**, choose **Output guidance**, expand the criteria if
needed, and use **Preview plan**. A change to the draft invalidates the preview.
Submission carries the exact execution tuple and selected content digest.
Multiple versions remain separate choices. Removed or changed criteria remain
visible as unavailable until the user chooses a replacement or no guidance;
they never silently become an ordinary request.

MCP exposes `list_output_profiles`. Pass its exact `{id, version, digest}` as
`outputProfile` to `plan_task`, `route_preview`, `ask_provider`, `route_and_ask`,
`run_committee`, `broadcast` or `submit_task`. The equivalent REST field is
accepted by `/api/plan`, `/api/route`, `/api/workspace/validate`, `/api/oneshot`,
`/api/broadcast` and `/api/tasks`. Discovery is authenticated and invokes no model.

```json
{
  "kind": "claude",
  "prompt": "Compare the two supplied cache designs in at most 150 words.",
  "dangerous": false,
  "outputProfile": { "id": "decision-analysis", "version": 1 }
}
```

The digest is optional for a new request; include the returned digest when
reusing a preview. Server admission resolves the selection, verifies original
and compiled grounding, and checks the complete text against provider limits.
It does not grant workspace access, tools, a larger budget or a different
authority mode. A raw prompt that resembles a profile header is ordinary text.

Plan/admission responses include `outputProfile` and `preparedPrompt` when a
profile is selected. The latter is ordinary text containing the original
request followed by criteria, version, catalog version and content digest.
It excludes later inline-evidence rendering and the provider policy prefix.
Send the original prompt plus selector, **or** prepared text without a selector;
sending both appends the criteria twice.

MCP verifies the admitted descriptor and compiled bytes, compares local and
live final-prompt hashes, and includes the admitted hash in cache identity.
Profiled dispatch sends `expectedPromptHash`; the server rejects policy/text
drift before invocation. Missing or mismatched returned prompt evidence is
non-cacheable and cannot establish a verdict. Committee member packets are
fully preflighted before any member starts; a chair's packet is validated
after member results exist and before the chair is invoked.

Queue submission stores the compiled ordinary prompt and existing execution
fields. Original task classification is retained through existing tier fields.
There is no second queue, profile lifecycle store or runtime catalog lookup
when that queued text executes. Updating a catalog cannot rewrite stored task
text. Compiled queued prompts above 100,000 UTF-16 code units reject before
the queue's existing clamp. The text/digest snapshot is an integrity reference,
not an authenticated evidence claim or a promise that an ID/version can never
be republished with different content.

There is no dedicated CLI profile flag and no automatic profile selector in
managed workflow phases. The standalone
[`relaybridge-output-quality` skill](../skills/relaybridge-output-quality/SKILL.md)
teaches clients to use supported tools. It ships in the repository; existing
installed clients do not gain it until their skill registration is updated.

## Public references

`list_workflow_library`, `GET /api/workflow-library`, and the Tasks panel list
six curated references: Superpowers systematic debugging, Anthropic MCP
builder, Agent Skills specification, GitHub MCP server configuration, Context7
MCP documentation, and Playwright CLI. The catalog records an immutable source
commit, exact source-file SHA-256, verification date and pinned license URL.
All entries are `available_not_connected` with null connection evidence.

The summaries and criteria are locally authored. Upstream source files,
commands, hooks, plugins and executable configuration are not loaded by this
catalog. The Anthropic MCP builder's license applies to that specific skill;
Agent Skills specification documentation is CC-BY-4.0, distinct from its code
license. Refer to each entry's exact license before copying upstream material.
Source review does not establish package safety or a working MCP connection.

## Evaluation and limits

Deterministic tests cover prompt preservation, digest drift, grounding,
transport/queue limits, preview/submission, committee preflight, receipt hash
correlation and cache behavior. These checks establish delivery semantics;
they do not establish that every model produces better prose or code.

`test/fixtures/output-quality-cases.json` contains bounded evaluation prompts
and observable criteria. Compare baseline and profiled outputs using the same
provider, model, effort, evidence and length constraint. Keep their exact
receipts, score without revealing the condition to the assessor, and report
ties and regressions. Avoid treating a small advisory sample as a benchmark.
Recorded results and provider qualification limits belong in
[`OVERNIGHT-REFINEMENT-20260908.md`](OVERNIGHT-REFINEMENT-20260908.md).
