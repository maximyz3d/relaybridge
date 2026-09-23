# Native conversations in the workspace

The main Conversations sidebar can show configured CLI conversations alongside
project conversations. Selecting one opens its live terminal in the workspace,
with a separate Saved history view. Native input uses the CLI's own composer;
it does not start a Codex project-delegator turn.

Opt a provider into the sidebar in the operator's runtime `cli-config.json`:

```json
"workspaceConversation": {
  "title": "Duet — Claude copy",
  "cwd": "/home/you/projects",
  "collabId": "c_existing_saved_history",
  "description": "Independent copy with the original conversation context."
}
```

`title` and `cwd` are required; `collabId` and `description` are optional.
The provider's `safe` command must resume the intended native conversation.
Configure an exclusive launcher (for example, a per-conversation `flock`) to
prevent concurrent resumes from different browser clients. The UI serializes
its own launch clicks and checks existing sessions before launching, but that
is not a cross-client server lock. It always requests `dangerous:false`.

Entries persist through service restarts because configuration, not an ephemeral
terminal ID, defines them. Reload restores the selected provider kind. Attaching
to an existing live session never starts a new one. When none is running,
**Resume conversation** is an explicit action. Changing conversations closes
the browser connection without stopping the CLI or discarding its input.

**Saved history** is a snapshot from a collaboration room, not a live mirror of
the CLI transcript. The native CLI retains its own full context. Copying a chat
does not isolate shared files or hardware, and later messages in the original
conversation do not automatically synchronize with the copy.

The live view uses xterm and the existing authenticated WebSocket. Disconnects
disable input; **Reconnect** reads the terminal output again without replaying
keystrokes. If a session-launch response is lost, the UI checks for an accepted
launch before enabling a new attempt. A transport acknowledgment is not proof
of model consumption: verify the actual assistant response. The initial layout
fit can run before the socket finishes opening, so `onopen` always sends the
terminal's current size once the connection is live, even if the fit produced
no size change of its own.

All history and configuration labels render as plain text. The terminal uses
this page's CSP nonce for xterm-generated styles through its document override;
no global DOM patch, iframe, or relaxed CSP is needed. No tokens appear in the
visible UI. Existing project mutations are blocked while a native conversation
is selected, including saved retries and already-open task dialogs. Starting a
new project conversation always leaves native mode first, so the request is
never silently rejected by that guard.

xterm's own document-override handling has a bug (`CoreBrowserService.mainDocument`
resolves to the real `window.document` regardless of the override), so a style
element it creates for the renderer can bypass our nonced document facade
entirely and still be appended to a facade-created element, such as the screen
element. Rather than patch xterm or the global `Document`/`Node` prototypes,
the facade wraps `appendChild` on each element it creates: any style appended
to that element is given this page's nonce at the point of insertion,
regardless of which document created it. Elements and documents outside the
facade are never touched.

Check with `node --test test/native-conversations.test.js test/workspace-ui.test.js`
and verify the main workspace in Chrome with a real configured session.
