# Terminal input security review

The terminal intentionally accepts exact operator keystrokes, including shell commands. It sends bytes to an existing PTY; it does not interpolate a data field into a newly constructed shell command. Escaping these bytes would change approved commands and control keys.

Every session REST route is behind the capability-token middleware. WebSocket attachment independently validates the capability, pinned Host and browser Origin before installing input handlers. Terminal and host-execution tools are excluded from all remote MCP profiles. Possession of the local capability intentionally grants terminal authority; an authenticated reverse proxy preserving the allowed Host remains within that authority.

The September 11 review traced both callers and found no unauthenticated path to the PTY input sink. `test/terminal-auth.test.js` exercises the actual REST middleware and WebSocket handlers against wrong/missing tokens, hostile origins and hosts, then verifies exact bytes on the authorized path. `test/terminal-input.test.js` covers input bounds, and `test/remote-mcp.test.js` verifies remote tool exclusion. These are bounded regression checks, not a penetration-test claim.

CodeQL alert 87 (`js/code-injection`, PR 131) identifies this intentional command-input behavior. Its disposition is limited to this authenticated terminal sink; analysis remains enabled for all code and future findings.
