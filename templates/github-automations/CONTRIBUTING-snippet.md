<!-- BEGIN relaybridge-contributing (rb-template v1) -->
## Working with RelayBridge automations

1. **Branch from the issue** (Development sidebar → "Create a branch"), or put
   `Fixes #123` in your PR body — that link is what drives everything below.
2. **Open a DRAFT PR the moment you start.** `claim-on-start.yml` then assigns
   you to the issue and warns everyone if someone else is already on it — this
   is the duplicate-work guard, and it only works if the PR exists early.
3. **Pick a bump label** (`bump:patch` default / `bump:minor` / `bump:major`).
   On merge, `version-on-merge.yml` computes the next version, writes
   `VERSION` + `CHANGELOG.md`, and creates the annotated `vX.Y.Z` tag. Tags are
   append-only — never delete or move one.
4. Rollback = branch from a tag (`git checkout -b fix v1.2.3`), never reset.
<!-- END relaybridge-contributing -->
