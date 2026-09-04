<!-- BEGIN relaybridge-contributing (rb-template v4) -->
## Working with RelayBridge automations

1. **Link the issue.** Use `Fixes #123` when this PR completes the issue, or an
   exact `Tracks #123` line when the PR is partial and must not close it.
2. **Open a DRAFT PR the moment you start.** `claim-on-start.yml` then assigns
   you to the issue and warns everyone if someone else is already on it — this
   is the duplicate-work guard, and it only works if the PR exists early. The
   marker is updated instead of duplicated when the PR changes. Dropped links
   and unmerged closures release workflow-owned assignments when no active or
   completed claim generation retains them; manual assignments are preserved.
   Claims are automatic for trusted same-repository branches; fork and
   Dependabot PRs are excluded and require a maintainer to assign the issue.
3. **Pick a bump label** (`bump:patch` default / `bump:minor` / `bump:major`).
   An explicit `set-version:X.Y.Z` must use that strict numeric form and be
   greater than the current version. On merge, `version-on-merge.yml` computes
   the next version, writes `VERSION` + `CHANGELOG.md`, and creates the
   annotated `vX.Y.Z` tag. Tags are append-only — never delete or move one.
4. Rollback = branch from a tag (`git checkout -b fix v1.2.3`), never reset.
<!-- END relaybridge-contributing -->
