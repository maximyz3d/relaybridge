<!-- BEGIN relaybridge-contributing (rb-template v3) -->
## Working with RelayBridge automations

1. **Branch from the issue** (Development sidebar → "Create a branch"), or put
   `Fixes #123` in your PR body — that link is what drives everything below.
2. **Open a DRAFT PR the moment you start.** `claim-on-start.yml` then assigns
   you to the issue and warns everyone if someone else is already on it — this
   is the duplicate-work guard, and it only works if the PR exists early.
   Claims are automatic for trusted same-repository branches; fork and
   Dependabot PRs stay read-only and require a maintainer to assign the issue.
3. **Pick a bump label** (`bump:patch` default / `bump:minor` / `bump:major`).
   An explicit `set-version:X.Y.Z` must use that strict numeric form and be
   greater than the current version. On merge, `version-on-merge.yml` computes
   the next version, writes `VERSION` + `CHANGELOG.md`, and creates the
   annotated `vX.Y.Z` tag. Tags are append-only — never delete or move one.
4. Rollback = branch from a tag (`git checkout -b fix v1.2.3`), never reset.
<!-- END relaybridge-contributing -->
