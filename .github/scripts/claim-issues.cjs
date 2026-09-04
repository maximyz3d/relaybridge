// # rb-template v4
'use strict';

// Durable, idempotent issue-claim reconciliation for claim-on-start.yml.
// State lives in bot-authored marker comments so an edited or closed PR can
// release only assignments that this workflow manages. All mutations stay
// bounded to same-repository issues named by GitHub closing references or an
// exact `Tracks #N` line in the PR body.

const MAX_TRACKED_ISSUES = 20;
const WORKFLOW_BOT = 'github-actions[bot]';
const STATE_MARKER = 'relaybridge-claim-state';
const ISSUE_MARKER = 'relaybridge-issue-claim';

function parseTrackedIssueNumbers(body) {
  const found = new Set();
  let fence = null;

  for (const line of String(body || '').split(/\r?\n/)) {
    if (fence) {
      const closingFence = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closingFence && closingFence[1][0] === fence.kind
        && closingFence[1].length >= fence.length) fence = null;
      continue;
    }
    const openingFence = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (openingFence) {
      fence = { kind: openingFence[1][0], length: openingFence[1].length };
      continue;
    }

    const match = line.match(
      /^[ \t]{0,3}(?:[-*][ \t]+)?tracks\s*:?[ \t]+(#\d+(?:[ \t]*(?:,|\band\b)[ \t]*#\d+)*)[ \t]*[.!]?[ \t]*$/i,
    );
    if (!match) continue;
    for (const issueMatch of match[1].matchAll(/#(\d+)/g)) {
      const number = Number(issueMatch[1]);
      if (Number.isSafeInteger(number) && number > 0) found.add(number);
    }
    if (found.size > MAX_TRACKED_ISSUES) {
      throw new Error(`a PR may explicitly track at most ${MAX_TRACKED_ISSUES} issues`);
    }
  }

  return [...found].sort((a, b) => a - b);
}

function markerLine(kind, data) {
  return `<!-- ${kind} ${JSON.stringify(data)} -->`;
}

function parseMarker(body, kind) {
  const firstLine = String(body || '').split(/\r?\n/, 1)[0];
  const prefix = `<!-- ${kind} `;
  if (!firstLine.startsWith(prefix) || !firstLine.endsWith(' -->') || firstLine.length > 4096) {
    return null;
  }
  try {
    const parsed = JSON.parse(firstLine.slice(prefix.length, -4));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isWorkflowComment(comment) {
  return comment?.user?.login === WORKFLOW_BOT && comment?.user?.type === 'Bot';
}

function normalizedRecord(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.managed !== 'boolean') return null;
  if (value.managedAt !== null && typeof value.managedAt !== 'string') return null;
  if (value.managedEventId !== null && value.managedEventId !== undefined
    && !/^\d+$/.test(String(value.managedEventId))) return null;
  return {
    managed: value.managed,
    managedAt: value.managedAt || null,
    managedEventId: value.managedEventId === null || value.managedEventId === undefined
      ? null : String(value.managedEventId),
  };
}

function previousState(comments, prNumber, author) {
  for (const comment of [...comments].reverse()) {
    if (!isWorkflowComment(comment)) continue;
    const marker = parseMarker(comment.body, STATE_MARKER);
    if (!marker || marker.v !== 1 || marker.pr !== prNumber || marker.author !== author) continue;
    if (!marker.issues || typeof marker.issues !== 'object' || Array.isArray(marker.issues)) continue;
    const issues = {};
    let valid = true;
    for (const [key, value] of Object.entries(marker.issues)) {
      const number = Number(key);
      const record = normalizedRecord(value);
      if (!Number.isSafeInteger(number) || number <= 0 || !record) {
        valid = false;
        break;
      }
      issues[number] = record;
    }
    if (valid && Object.keys(issues).length <= MAX_TRACKED_ISSUES) {
      return { comment, issues, status: marker.status || 'active' };
    }
  }
  return null;
}

async function listComments(github, owner, repo, issueNumber) {
  return github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
}

async function upsertMarkerComment({ github, owner, repo, issueNumber, comments, kind, identity, body }) {
  const existing = [...comments].reverse().find((comment) => {
    if (!isWorkflowComment(comment)) return false;
    const marker = parseMarker(comment.body, kind);
    return marker && identity(marker);
  });

  if (!existing) {
    const { data } = await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return { action: 'created', comment: data };
  }
  if (existing.body === body) return { action: 'unchanged', comment: existing };
  const { data } = await github.rest.issues.updateComment({
    owner,
    repo,
    comment_id: existing.id,
    body,
  });
  return { action: 'updated', comment: data };
}

function safeCode(value) {
  return String(value || '').replace(/[`\r\n]/g, (char) => (char === '`' ? '\u02cb' : ' '));
}

function issueCommentBody({ pr, author, record, status, others = [], reason = null }) {
  const metadata = {
    v: 1,
    pr: pr.number,
    author,
    managed: record.managed,
    managedAt: record.managedAt,
    managedEventId: record.managedEventId,
    status,
  };
  const branch = safeCode(pr.head?.ref);
  let text;
  if (status === 'active') {
    text = `🔒 **@${author} is working on this** — PR #${pr.number} (\`${branch}\`).`;
    if (!record.managed) {
      text += '\n\nRelayBridge could not prove that it exclusively created this assignment, so it is treating the assignment as manual and will not remove it.';
    }
    if (others.length > 0) {
      text += `\n\n⚠️ **Possible duplicate work** — this issue is also assigned to ${others.map((login) => `@${login}`).join(', ')}. Sync before changing overlapping files.`;
    }
  } else if (status === 'completed') {
    text = `✅ **@${author}'s claim completed** — PR #${pr.number} merged. The issue assignment was preserved as history.`;
  } else {
    text = `🔓 **@${author}'s claim was released** — PR #${pr.number} ${reason || 'no longer tracks this issue'}.`;
  }
  return `${markerLine(ISSUE_MARKER, metadata)}\n${text}`;
}

function stateCommentBody({ pr, author, status, issues }) {
  const ordered = {};
  for (const number of Object.keys(issues).map(Number).sort((a, b) => a - b)) {
    ordered[number] = issues[number];
  }
  const marker = { v: 1, pr: pr.number, author, status, issues: ordered };
  const numbers = Object.keys(ordered).map((number) => `#${number}`);
  const summary = numbers.length > 0 ? numbers.join(', ') : 'none';
  return `${markerLine(STATE_MARKER, marker)}\nRelayBridge claim state for PR #${pr.number}: **${status}**; tracked issues: ${summary}.`;
}

async function closingIssueNumbers(github, core, owner, repo, prNumber) {
  const query = `
    query($owner:String!, $repo:String!, $number:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$number) {
          closingIssuesReferences(first:21) {
            nodes { number repository { nameWithOwner } }
          }
        }
      }
    }`;
  const result = await github.graphql(query, { owner, repo, number: prNumber });
  const nodes = result?.repository?.pullRequest?.closingIssuesReferences?.nodes || [];
  if (nodes.length > MAX_TRACKED_ISSUES) {
    throw new Error(`a PR may close or track at most ${MAX_TRACKED_ISSUES} issues`);
  }
  const localName = `${owner}/${repo}`.toLowerCase();
  const local = nodes.filter((node) => {
    const sameRepository = node?.repository?.nameWithOwner?.toLowerCase() === localName;
    if (!sameRepository && Number.isSafeInteger(node?.number)) {
      core.info(`Ignoring cross-repository closing reference #${node.number}.`);
    }
    return sameRepository;
  });
  return local.map((node) => node.number);
}

async function referencedIssueNumbers({ github, core, owner, repo, pr }) {
  const closing = await closingIssueNumbers(github, core, owner, repo, pr.number);
  const explicit = parseTrackedIssueNumbers(pr.body);
  const numbers = [...new Set([...closing, ...explicit])].sort((a, b) => a - b);
  if (numbers.length > MAX_TRACKED_ISSUES) {
    throw new Error(`a PR may close or track at most ${MAX_TRACKED_ISSUES} issues`);
  }
  return numbers;
}

async function resolveActiveIssues({ github, core, owner, repo, pr }) {
  const numbers = await referencedIssueNumbers({ github, core, owner, repo, pr });
  const issues = new Map();
  const missing = new Set();
  for (const number of numbers) {
    try {
      const { data } = await github.rest.issues.get({ owner, repo, issue_number: number });
      if (data.pull_request) {
        core.warning(`Tracks #${number} points to a pull request, not an issue; skipping it.`);
      } else if (data.state !== 'open') {
        core.warning(`Issue #${number} is not open; skipping its claim.`);
      } else {
        issues.set(number, data);
      }
    } catch (error) {
      if (error?.status === 404 || error?.status === 410) {
        core.warning(`Tracked issue #${number} does not exist or is unavailable; skipping it.`);
        missing.add(number);
        continue;
      }
      // Do not turn an API outage or permission failure into evidence that an
      // author intentionally dropped a link. Resolution completes before any
      // assignment mutation, so failing here preserves the prior claim state.
      throw new Error(
        `Could not safely validate tracked issue #${number}; no claims were changed: ${error.message}`,
        { cause: error },
      );
    }
  }
  return { issues, missing };
}

function issueMarkers(comments) {
  return comments.flatMap((comment) => {
    if (!isWorkflowComment(comment)) return [];
    const marker = parseMarker(comment.body, ISSUE_MARKER);
    const record = normalizedRecord(marker);
    if (!marker || marker.v !== 1 || !Number.isSafeInteger(marker.pr) || marker.pr <= 0
      || typeof marker.author !== 'string' || !record) return [];
    return [{ comment, marker: { ...marker, ...record } }];
  });
}

function currentPrIssueMarker(comments, prNumber, author) {
  for (const { marker } of [...issueMarkers(comments)].reverse()) {
    if (marker.pr === prNumber && marker.author === author) return marker;
  }
  return null;
}

async function recoverKnownIssues({
  github, core, owner, repo, pr, author, issues,
}) {
  const recovered = {};
  const numbers = Object.keys(issues).map(Number);
  for (const number of [...new Set(numbers)].sort((a, b) => a - b)) {
    let comments;
    try {
      comments = await listComments(github, owner, repo, number);
    } catch (error) {
      if (error?.status === 404 || error?.status === 410) {
        core.warning(`Previously tracked issue #${number} is unavailable; dropping its claim state without mutation.`);
        continue;
      }
      throw new Error(
        `Could not safely recover claim state for issue #${number}; no claims were changed: ${error.message}`,
        { cause: error },
      );
    }

    const marker = currentPrIssueMarker(comments, pr.number, author);
    if (marker?.status === 'released') continue;
    if (marker?.status === 'active' || marker?.status === 'completed') {
      recovered[number] = normalizedRecord(marker);
    } else if (Object.hasOwn(issues, number)) {
      recovered[number] = issues[number];
    }
  }
  return recovered;
}

async function otherRetainedManagedClaim({
  github, core, owner, repo, comments, currentPr, author, managedEventId, pullCache, failSafe,
}) {
  for (const { marker } of issueMarkers(comments)) {
    if (marker.pr === currentPr || marker.author !== author || !marker.managed
      || !managedEventId || marker.managedEventId !== managedEventId) {
      continue;
    }
    if (marker.status === 'completed') return marker;
    if (marker.status !== 'active') continue;
    try {
      if (!pullCache.has(marker.pr)) {
        const { data } = await github.rest.pulls.get({ owner, repo, pull_number: marker.pr });
        pullCache.set(marker.pr, data);
      }
      const other = pullCache.get(marker.pr);
      if (other?.state === 'open' || other?.merged === true) return marker;
    } catch (error) {
      core.warning(`Could not verify competing claim PR #${marker.pr}: ${error.message}`);
      if (failSafe) return { managed: true, managedAt: null, status: 'unknown' };
    }
  }
  return null;
}

async function listEvents(github, owner, repo, issueNumber) {
  return github.paginate(github.rest.issues.listEvents, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
}

function latestAssignmentEvent(events, author) {
  return events
    .filter((event) => event.event === 'assigned'
      && event.assignee?.login === author
      && /^\d+$/.test(String(event.id || ''))
      && Number.isFinite(Date.parse(event.created_at)))
    .sort((left, right) => {
      const byTime = Date.parse(left.created_at) - Date.parse(right.created_at);
      if (byTime !== 0) return byTime;
      const leftId = BigInt(String(left.id));
      const rightId = BigInt(String(right.id));
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    })
    .at(-1) || null;
}

function hasManualAssignmentInEvents(events, author, managedAt) {
  if (!managedAt || !Number.isFinite(Date.parse(managedAt))) return true;
  const since = Date.parse(managedAt);
  return events.some((event) => event.event === 'assigned'
    && event.assignee?.login === author
    && event.actor?.login !== WORKFLOW_BOT
    && Number.isFinite(Date.parse(event.created_at))
    && Date.parse(event.created_at) >= since);
}

async function claimIssue({
  github, core, owner, repo, pr, author, issue, previous, pullCache,
}) {
  const comments = await listComments(github, owner, repo, issue.number);
  // Re-read immediately before assignment. If a human wins the race after
  // initial link validation, the workflow must never take ownership of that
  // manual assignment merely because addAssignees is idempotent.
  const { data: currentIssue } = await github.rest.issues.get({
    owner,
    repo,
    issue_number: issue.number,
  });
  const assignees = (currentIssue.assignees || []).map((entry) => entry.login);
  const alreadyAssigned = assignees.includes(author);
  let record;

  if (!alreadyAssigned) {
    const beforeEvents = await listEvents(github, owner, repo, issue.number);
    const beforeIds = new Set(beforeEvents
      .filter((event) => event.id !== null && event.id !== undefined)
      .map((event) => String(event.id)));
    await github.rest.issues.addAssignees({
      owner,
      repo,
      issue_number: issue.number,
      assignees: [author],
    });
    const newAssignmentEvents = (await listEvents(github, owner, repo, issue.number))
      .filter((event) => event.id !== null && event.id !== undefined
        && !beforeIds.has(String(event.id))
        && event.event === 'assigned'
        && event.assignee?.login === author);
    const workflowEvent = newAssignmentEvents.find((event) => isWorkflowComment({ user: event.actor })
      && Number.isFinite(Date.parse(event.created_at)));
    const competingManualEvent = newAssignmentEvents.some((event) => !isWorkflowComment({ user: event.actor }));
    record = workflowEvent && !competingManualEvent
      ? {
        managed: true,
        managedAt: workflowEvent.created_at,
        managedEventId: String(workflowEvent.id),
      }
      : { managed: false, managedAt: null, managedEventId: null };
  } else {
    const generation = latestAssignmentEvent(
      await listEvents(github, owner, repo, issue.number), author);
    const ownMarker = currentPrIssueMarker(comments, pr.number, author);
    if (previous?.managed && generation
      && previous.managedEventId === String(generation.id)) {
      record = previous;
    } else if (ownMarker?.status === 'active'
      && (!ownMarker.managed || (generation
        && ownMarker.managedEventId === String(generation.id)))) {
      // The issue marker is a second durable copy of ownership. It recovers a
      // run whose issue mutation succeeded before its PR state was finalized.
      record = normalizedRecord(ownMarker);
    } else {
      const shared = await otherRetainedManagedClaim({
        github,
        core,
        owner,
        repo,
        comments,
        currentPr: pr.number,
        author,
        managedEventId: generation ? String(generation.id) : null,
        pullCache,
        failSafe: false,
      });
      record = shared
        ? normalizedRecord(shared)
        : { managed: false, managedAt: null, managedEventId: null };
    }
  }

  const body = issueCommentBody({
    pr,
    author,
    record,
    status: 'active',
    others: assignees.filter((login) => login !== author).sort(),
  });
  await upsertMarkerComment({
    github,
    owner,
    repo,
    issueNumber: issue.number,
    comments,
    kind: ISSUE_MARKER,
    identity: (marker) => marker.v === 1 && marker.pr === pr.number,
    body,
  });
  return record;
}

async function releaseIssue({
  github, core, owner, repo, pr, author, issueNumber, record, pullCache, reason,
}) {
  const comments = await listComments(github, owner, repo, issueNumber);
  let removed = false;

  if (record.managed) {
    const shared = await otherRetainedManagedClaim({
      github,
      core,
      owner,
      repo,
      comments,
      currentPr: pr.number,
      author,
      managedEventId: record.managedEventId,
      pullCache,
      failSafe: true,
    });
    const beforeRemovalEvents = shared ? [] : await listEvents(github, owner, repo, issueNumber);
    const currentGeneration = latestAssignmentEvent(beforeRemovalEvents, author);
    const sameGeneration = record.managedEventId && currentGeneration
      && record.managedEventId === String(currentGeneration.id);
    const manual = shared ? false : !sameGeneration
      || hasManualAssignmentInEvents(beforeRemovalEvents, author, record.managedAt);
    if (!shared && record.managedEventId && !manual) {
      const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
      if ((issue.assignees || []).some((entry) => entry.login === author)) {
        await github.rest.issues.removeAssignees({
          owner,
          repo,
          issue_number: issueNumber,
          assignees: [author],
        });
        removed = true;
        try {
          const afterRemovalEvents = await listEvents(github, owner, repo, issueNumber);
          const manualAfterRemoval = hasManualAssignmentInEvents(
            afterRemovalEvents, author, record.managedAt);
          const generationAfterRemoval = latestAssignmentEvent(afterRemovalEvents, author);
          const generationChanged = generationAfterRemoval
            && String(generationAfterRemoval.id) !== record.managedEventId;
          const { data: afterRemoval } = await github.rest.issues.get({
            owner, repo, issue_number: issueNumber,
          });
          const assignedAfterRemoval = (afterRemoval.assignees || [])
            .some((entry) => entry.login === author);
          if ((manualAfterRemoval || generationChanged) && !assignedAfterRemoval) {
            await github.rest.issues.addAssignees({
              owner,
              repo,
              issue_number: issueNumber,
              assignees: [author],
            });
          }
          if (manualAfterRemoval || generationChanged || assignedAfterRemoval) removed = false;
        } catch (error) {
          // Once removal has happened, uncertainty must restore the assignment
          // instead of leaving a possibly manual assignment deleted.
          await github.rest.issues.addAssignees({
            owner,
            repo,
            issue_number: issueNumber,
            assignees: [author],
          });
          throw new Error(`Could not verify assignment cleanup; restored @${author}: ${error.message}`,
            { cause: error });
        }
      }
    }
  }

  const body = issueCommentBody({
    pr,
    author,
    record,
    status: 'released',
    reason: `${reason}${removed ? '; its workflow-managed assignment was removed' : '; its assignment was preserved'}`,
  });
  await upsertMarkerComment({
    github,
    owner,
    repo,
    issueNumber,
    comments,
    kind: ISSUE_MARKER,
    identity: (marker) => marker.v === 1 && marker.pr === pr.number,
    body,
  });
}

async function completeIssue({ github, owner, repo, pr, author, issueNumber, record }) {
  const comments = await listComments(github, owner, repo, issueNumber);
  const body = issueCommentBody({ pr, author, record, status: 'completed' });
  await upsertMarkerComment({
    github,
    owner,
    repo,
    issueNumber,
    comments,
    kind: ISSUE_MARKER,
    identity: (marker) => marker.v === 1 && marker.pr === pr.number,
    body,
  });
}

async function reconcileClaims({ github, context, core }) {
  const eventPr = context?.payload?.pull_request;
  if (!eventPr || !Number.isSafeInteger(eventPr.number)) {
    throw new Error('claim reconciliation requires a pull_request event payload');
  }
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  // Event delivery and queued-run ordering are not authoritative. Always
  // reconcile from the current server-side PR so an old rerun cannot reclaim
  // a closed PR or restore a link removed by a newer edit.
  const { data: pr } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: eventPr.number,
  });
  if (!pr || pr.number !== eventPr.number || !pr.user?.login) {
    throw new Error('could not load the current pull request state');
  }
  const author = pr.user.login;
  const closed = pr.state === 'closed';
  const merged = closed && pr.merged === true;
  const prComments = await listComments(github, owner, repo, pr.number);
  const prior = previousState(prComments, pr.number, author);
  let previousIssues = prior?.issues || {};
  const pullCache = new Map([[pr.number, pr]]);

  if (prior) {
    // The issue marker is the authoritative second copy when a prior run
    // finished an issue mutation but failed to finalize the PR state marker.
    previousIssues = await recoverKnownIssues({
      github, core, owner, repo, pr, author, issues: previousIssues,
    });
  }

  let status = 'active';
  let nextIssues = {};
  let desired = null;
  let missing = new Set();
  let referenced = null;
  let stateExists = Boolean(prior);

  if (closed && !prior) {
    core.info('No workflow-owned claim state exists for this closed PR; preserving all assignments.');
    return { status: merged ? 'merged' : 'closed_unmerged', issues: {}, noPriorState: true };
  }

  if (merged) {
    referenced = new Set(await referencedIssueNumbers({ github, core, owner, repo, pr }));
  } else if (!closed) {
    ({ issues: desired, missing } = await resolveActiveIssues({
      github, core, owner, repo, pr,
    }));
  }

  if (merged) {
    status = 'merged';
    for (const number of Object.keys(previousIssues).map(Number).sort((a, b) => a - b)) {
      if (referenced.has(number)) {
        nextIssues[number] = previousIssues[number];
        await completeIssue({
          github, owner, repo, pr, author, issueNumber: number, record: previousIssues[number],
        });
      } else {
        await releaseIssue({
          github,
          core,
          owner,
          repo,
          pr,
          author,
          issueNumber: number,
          record: previousIssues[number],
          pullCache,
          reason: 'no longer tracked when the PR merged',
        });
      }
    }
  } else if (closed) {
    status = 'closed_unmerged';
    for (const number of Object.keys(previousIssues).map(Number).sort((a, b) => a - b)) {
      await releaseIssue({
        github,
        core,
        owner,
        repo,
        pr,
        author,
        issueNumber: number,
        record: previousIssues[number],
        pullCache,
        reason: 'closed without merge',
      });
    }
  } else {
    // Release dropped claims first. Their prior PR state is already durable,
    // so a failed run can safely retry without journaling a union larger than
    // the 20-issue bound.
    for (const number of Object.keys(previousIssues).map(Number).sort((a, b) => a - b)) {
      if (desired.has(number)) continue;
      if (missing.has(number)) {
        core.info(`Issue #${number} is unavailable; dropping its state without assignment mutation.`);
        continue;
      }
      await releaseIssue({
        github,
        core,
        owner,
        repo,
        pr,
        author,
        issueNumber: number,
        record: previousIssues[number],
        pullCache,
        reason: 'no longer tracks this issue',
      });
    }

    const journalIssues = {};
    let hasNewIssue = false;
    for (const number of desired.keys()) {
      if (Object.hasOwn(previousIssues, number)) {
        journalIssues[number] = previousIssues[number];
      } else {
        hasNewIssue = true;
        journalIssues[number] = { managed: false, managedAt: null, managedEventId: null };
      }
    }
    if (hasNewIssue || prior?.status === 'reconciling') {
      // Persist the exact target set before a newly linked issue can be
      // assigned. If finalization later fails, retry/close can recover the
      // exact managed record from that issue's authenticated marker.
      const journal = await upsertMarkerComment({
        github,
        owner,
        repo,
        issueNumber: pr.number,
        comments: prComments,
        kind: STATE_MARKER,
        identity: (marker) => marker.v === 1 && marker.pr === pr.number && marker.author === author,
        body: stateCommentBody({ pr, author, status: 'reconciling', issues: journalIssues }),
      });
      prComments.push(journal.comment);
      stateExists = true;
    }

    for (const [number, issue] of desired) {
      nextIssues[number] = await claimIssue({
        github,
        core,
        owner,
        repo,
        pr,
        author,
        issue,
        previous: previousIssues[number],
        pullCache,
      });
    }
  }

  if (!stateExists && Object.keys(nextIssues).length === 0) {
    core.info('No linked issue. Add `Fixes #123` to close it on merge, or an exact `Tracks #123` line for partial work.');
    return { status, issues: nextIssues };
  }

  const stateBody = stateCommentBody({ pr, author, status, issues: nextIssues });
  await upsertMarkerComment({
    github,
    owner,
    repo,
    issueNumber: pr.number,
    comments: prComments,
    kind: STATE_MARKER,
    identity: (marker) => marker.v === 1 && marker.pr === pr.number && marker.author === author,
    body: stateBody,
  });
  return { status, issues: nextIssues };
}

module.exports = {
  ISSUE_MARKER,
  MAX_TRACKED_ISSUES,
  STATE_MARKER,
  WORKFLOW_BOT,
  issueCommentBody,
  markerLine,
  parseMarker,
  parseTrackedIssueNumbers,
  previousState,
  reconcileClaims,
  stateCommentBody,
};
