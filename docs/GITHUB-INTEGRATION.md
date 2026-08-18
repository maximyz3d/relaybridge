# GitHub integration

Makes every RelayBridge run against an enrolled repo **visible, attributed,
versioned, and tracked in real time**, with a rollback-able archive — as a side
effect of running, never as a task anyone has to remember.

## Division of labor — best of both worlds

| Layer | Lives in | Does |
|---|---|---|
| **Server-side Actions** (source of truth) | each project repo | `claim-on-start.yml`: assigns the PR author to the linked issue + duplicate-work warning. `version-on-merge.yml`: reads the PR's bump label on merge, writes `VERSION` + `CHANGELOG.md`, creates the annotated `vX.Y.Z` tag (and optionally a Release). Works for **every** contributor, RelayBridge or not. |
| **RelayBridge** (real-time control plane) | this repo | checkpoint commits per run, DEVLOG entries, sticky issue comments, draft-PR lifecycle, **dictates** the bump label, **mirrors** the version history, one-action repo onboarding. |

RelayBridge **never** creates, moves, or deletes tags and never writes the
version number. Versions are append-only; rollback = a new branch from a tag.

## Enrolling a repo

`config/github-repos.json`:

```jsonc
{
  "repos": [{
    "name": "DarthN99/SQ4D_Duet_UI",
    "path": "D:\\Claude\\SQ4D_Duet_UI",
    "autoCommit": true,
    "autoPush": false,          // opt-in; default false
    "dryRun": true,             // log intended actions only — start here
    "trackingMode": "checkpoint-on-branch",  // or "mirror-branch"
    "branchPrefix": "relaybridge/",
    "devlogPath": "docs/DEVLOG.md",
    "openDraftPr": true,
    "summaryProvider": "copilot",
    "versioning": { "dictateBump": true, "defaultBump": "patch", "mirrorFromGitHub": true }
  }]
}
```

Or run **＋ Onboard repo** in the 🐙 GitHub dashboard panel /
`github_onboard_repo` MCP tool / `POST /api/github/onboard` — one action
installs the workflows, PR template, CONTRIBUTING snippet, and bump labels via
a **draft PR**, and enrolls the repo with safe defaults. `upgrade-repos`
re-provisions any repo whose installed `rb-template` version has drifted behind
`templates/github-automations/`.

## Associating a run

Put tags anywhere in the prompt (or `intent` field):

- `#123` or `issue:123` — link the run to an issue
- `bump:patch` (default) | `bump:minor` | `bump:major` — PR bump label
- `version:1.4.0` — explicit `set-version:1.4.0` label

Optional request body fields on `/api/oneshot`: `user` (attribution; defaults
to the OS account) and `intent` (one-line purpose for the commit subject).

## What happens after a run

Only **successful** runs track (a dropped-out run may have half-applied edits a
human should triage). In the enrolled repo:

1. `git status --porcelain`; nothing changed → no-op.
2. Stage changes, honoring `.gitignore` **plus a hard secret skip-list**
   (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, tokens…) that applies
   even to files that are *not* gitignored. Status is read with `-uall -z` so
   that a secret inside a **newly created directory** is seen and skipped
   individually rather than swept in as part of the directory, and so paths
   with spaces or non-ASCII characters stage correctly.
3. Checkpoint commit: `relaybridge(run <id>): <intent> [#<issue>]`, body lists
   files, provider, user. Refuses to commit on the default branch
   (`mirror-branch` mode moves to `relaybridge/<user>/<issue>` instead).
4. DEVLOG entry appended + committed separately.
5. `autoPush:true` → push branch; then ensure a **draft PR** with
   `Fixes #<issue>` exists, apply the bump label, and upsert one sticky issue
   comment with the latest run summary.

Failures are logged to `data/github-activity.jsonl` and surfaced via
`/api/github/activity` — they never delay or fail the provider response.

## Rollback / archive

Every merged PR produces an annotated `vX.Y.Z` tag on GitHub (see
`templates/github-automations/version-on-merge.yml`). Inspect and restore with
plain git, or through RelayBridge:

- `github_list_versions` / `GET /api/github/versions?repo=o/r`
- `github_show_version`
- `github_checkout_version` — creates a **new** branch from the tag and leaves
  your working tree exactly where it is (it returns the branch name; you check
  it out when ready). Never a force-reset.

## Guardrails

- Never force-push; never commit/push to the default branch; never touch tags.
- Auto-push opt-in per repo; `dryRun` mode logs the exact commit/push/label it
  *would* make.
- Secret skip-list enforced unconditionally.
- Auth comes from the existing `gh` login — no tokens in config.
- Onboarding operates on a branch + draft PR; branch protection, org, and
  billing settings are surfaced as manual steps, never changed.
