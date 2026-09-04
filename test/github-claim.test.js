'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const claim = require('../.github/scripts/claim-issues.cjs');

const BOT = { login: claim.WORKFLOW_BOT, type: 'Bot' };
const HUMAN = { login: 'maximyz3d', type: 'User' };
const FIXED_NOW = '2026-09-04T12:00:00.000Z';

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixture() {
  const issues = new Map();
  const pulls = new Map();
  const comments = new Map();
  const events = new Map();
  const closing = new Map();
  let nextCommentId = 1;
  let nextEventId = 1;
  const calls = {
    addAssignees: [],
    removeAssignees: [],
    createComment: [],
    updateComment: [],
    pullsGet: [],
  };

  const commentsFor = (number) => {
    if (!comments.has(number)) comments.set(number, []);
    return comments.get(number);
  };
  const eventsFor = (number) => {
    if (!events.has(number)) events.set(number, []);
    return events.get(number);
  };
  const issueFor = (number) => {
    const issue = issues.get(number);
    if (!issue) throw new Error(`issue ${number} not found`);
    return issue;
  };

  const github = {
    paginate: async (endpoint, params) => (await endpoint(params)).data,
    graphql: async (_query, variables) => ({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: (closing.get(variables.number) || []).map((reference) => ({
              number: typeof reference === 'number' ? reference : reference.number,
              repository: {
                nameWithOwner: typeof reference === 'number'
                  ? 'maximyz3d/relaybridge'
                  : reference.repository,
              },
            })),
          },
        },
      },
    }),
    rest: {
      issues: {
        listComments: async ({ issue_number }) => ({ data: copy(commentsFor(issue_number)) }),
        createComment: async ({ issue_number, body }) => {
          const entry = { id: nextCommentId++, body, user: BOT };
          commentsFor(issue_number).push(entry);
          calls.createComment.push({ issue_number, body });
          return { data: copy(entry) };
        },
        updateComment: async ({ comment_id, body }) => {
          for (const [issueNumber, values] of comments) {
            const entry = values.find((candidate) => candidate.id === comment_id);
            if (!entry) continue;
            entry.body = body;
            calls.updateComment.push({ issue_number: issueNumber, comment_id, body });
            return { data: copy(entry) };
          }
          throw new Error(`comment ${comment_id} not found`);
        },
        get: async ({ issue_number }) => ({ data: copy(issueFor(issue_number)) }),
        addAssignees: async ({ issue_number, assignees }) => {
          const issue = issueFor(issue_number);
          for (const login of assignees) {
            if (!issue.assignees.some((entry) => entry.login === login)) {
              issue.assignees.push({ login });
              eventsFor(issue_number).push({
                id: nextEventId++,
                event: 'assigned',
                assignee: { login },
                actor: BOT,
                created_at: '2026-09-04T12:00:01.000Z',
              });
            }
          }
          calls.addAssignees.push({ issue_number, assignees: [...assignees] });
          return { data: copy(issue) };
        },
        removeAssignees: async ({ issue_number, assignees }) => {
          const issue = issueFor(issue_number);
          issue.assignees = issue.assignees.filter((entry) => !assignees.includes(entry.login));
          calls.removeAssignees.push({ issue_number, assignees: [...assignees] });
          return { data: copy(issue) };
        },
        listEvents: async ({ issue_number }) => ({ data: copy(eventsFor(issue_number)) }),
      },
      pulls: {
        get: async ({ pull_number }) => {
          calls.pullsGet.push(pull_number);
          const pull = pulls.get(pull_number);
          if (!pull) throw new Error(`pull ${pull_number} not found`);
          return { data: copy(pull) };
        },
      },
    },
  };

  return {
    github,
    calls,
    issues,
    pulls,
    comments,
    events,
    closing,
    commentsFor,
    eventsFor,
    addIssue(number, assignees = []) {
      issues.set(number, {
        number,
        state: 'open',
        assignees: assignees.map((login) => ({ login })),
      });
    },
    addPull(number, state = 'open', options = {}) {
      pulls.set(number, {
        number,
        state,
        merged: options.merged || false,
        body: options.body || '',
        user: { login: options.author || HUMAN.login },
        head: { ref: options.branch || `feature/pr-${number}` },
      });
    },
    addComment(issueNumber, body, user = BOT) {
      const entry = { id: nextCommentId++, body, user };
      commentsFor(issueNumber).push(entry);
      return entry;
    },
  };
}

function core() {
  return {
    infos: [],
    warnings: [],
    info(message) { this.infos.push(message); },
    warning(message) { this.warnings.push(message); },
  };
}

function pullPayload(number, {
  action = 'opened', body = '', state = 'open', merged = false, author = HUMAN.login,
} = {}) {
  return {
    repo: { owner: 'maximyz3d', repo: 'relaybridge' },
    payload: {
      action,
      pull_request: {
        number,
        body,
        state,
        merged,
        user: { login: author },
        head: { ref: `feature/pr-${number}` },
      },
    },
  };
}

async function reconcile(state, number, options = {}) {
  const current = state.pulls.get(number);
  if (current && options.syncPull !== false) {
    if (Object.hasOwn(options, 'body')) current.body = options.body;
    if (Object.hasOwn(options, 'state')) current.state = options.state;
    if (Object.hasOwn(options, 'merged')) current.merged = options.merged;
    if (Object.hasOwn(options, 'author')) current.user.login = options.author;
  }
  const payloadOptions = { ...options };
  delete payloadOptions.syncPull;
  return claim.reconcileClaims({
    github: state.github,
    context: pullPayload(number, payloadOptions),
    core: options.core || core(),
    now: () => FIXED_NOW,
  });
}

function markerFor(state, issueNumber, kind, prNumber) {
  return state.commentsFor(issueNumber)
    .map((comment) => claim.parseMarker(comment.body, kind))
    .find((marker) => marker?.pr === prNumber);
}

test('Tracks parser is explicit, bounded, deduplicated, and ignores fenced examples', () => {
  const body = [
    'Context mentions Tracks #99 in prose and must not claim it.',
    'Tracks #12',
    '- tracks: #13, #14 and #12.',
    '```md',
    'Tracks #88',
    '```',
  ].join('\n');
  assert.deepEqual(claim.parseTrackedIssueNumbers(body), [12, 13, 14]);
  assert.deepEqual(claim.parseTrackedIssueNumbers('Tracking #4\nRelates to #5'), []);
  assert.deepEqual(claim.parseTrackedIssueNumbers([
    '````md',
    '```',
    'Tracks #42',
    '````',
    '    Tracks #43',
  ].join('\n')), [], 'shorter fences and indented code must remain non-operative examples');
  assert.throws(
    () => claim.parseTrackedIssueNumbers(
      Array.from({ length: claim.MAX_TRACKED_ISSUES + 1 }, (_, index) => `Tracks #${index + 1}`).join('\n')),
    /at most 20 issues/,
  );
});

test('open and edited events reconcile closing plus Tracks links without duplicate comments', async () => {
  const state = fixture();
  state.addIssue(1);
  state.addIssue(2, ['reviewer']);
  state.addPull(101);
  state.closing.set(101, [2]);

  await reconcile(state, 101, { body: 'Tracks #1' });
  assert.deepEqual(state.issues.get(1).assignees.map((entry) => entry.login), [HUMAN.login]);
  assert.deepEqual(state.issues.get(2).assignees.map((entry) => entry.login), ['reviewer', HUMAN.login]);
  assert.equal(state.calls.addAssignees.length, 2);
  assert.equal(state.calls.createComment.length, 3, 'two issue markers plus one PR state marker');
  assert.equal(state.calls.updateComment.length, 1, 'the PR intent journal is finalized in place');
  assert.match(state.commentsFor(2)[0].body, /Possible duplicate work/);

  await reconcile(state, 101, { action: 'edited', body: 'Tracks #1' });
  assert.equal(state.calls.addAssignees.length, 2, 'an idempotent edit must not assign again');
  assert.equal(state.calls.createComment.length, 3, 'an idempotent edit must not append comments');
  assert.equal(state.calls.updateComment.length, 1, 'unchanged marker bodies must not churn');

  state.closing.set(101, []);
  await reconcile(state, 101, { action: 'edited', body: '' });
  assert.deepEqual(state.calls.removeAssignees.map((entry) => entry.issue_number).sort(), [1, 2]);
  assert.deepEqual(state.issues.get(1).assignees, []);
  assert.deepEqual(state.issues.get(2).assignees.map((entry) => entry.login), ['reviewer']);
  assert.equal(markerFor(state, 1, claim.ISSUE_MARKER, 101).status, 'released');
  assert.equal(markerFor(state, 2, claim.ISSUE_MARKER, 101).status, 'released');
  assert.deepEqual(markerFor(state, 101, claim.STATE_MARKER, 101).issues, {});
});

test('a confirmed missing Tracks reference does not block valid issue claims', async () => {
  const state = fixture();
  const log = core();
  state.addIssue(19);
  state.addPull(119);
  const originalGet = state.github.rest.issues.get;
  state.github.rest.issues.get = async (params) => {
    if (params.issue_number === 9999) {
      throw Object.assign(new Error('not found'), { status: 404 });
    }
    return originalGet(params);
  };

  const result = await reconcile(state, 119, { body: 'Tracks #19, #9999', core: log });

  assert.deepEqual(Object.keys(result.issues), ['19']);
  assert.deepEqual(state.issues.get(19).assignees.map((entry) => entry.login), [HUMAN.login]);
  assert.match(log.warnings.join('\n'), /Tracked issue #9999 does not exist or is unavailable/);
});

test('a confirmed unavailable issue drops stale state without attempting removal', async () => {
  const state = fixture();
  state.addIssue(25);
  state.addPull(125);
  await reconcile(state, 125, { body: 'Tracks #25' });
  const originalGet = state.github.rest.issues.get;
  state.github.rest.issues.get = async (params) => {
    if (params.issue_number === 25) {
      throw Object.assign(new Error('gone'), { status: 410 });
    }
    return originalGet(params);
  };

  const result = await reconcile(state, 125, { action: 'edited', body: 'Tracks #25' });

  assert.deepEqual(result.issues, {});
  assert.equal(state.calls.removeAssignees.length, 0);
  assert.deepEqual(state.issues.get(25).assignees.map((entry) => entry.login), [HUMAN.login]);
  assert.deepEqual(markerFor(state, 125, claim.STATE_MARKER, 125).issues, {});
});

test('failure creating the write-ahead PR journal performs no issue mutation', async () => {
  const state = fixture();
  state.addIssue(20);
  state.addPull(120);
  const originalCreate = state.github.rest.issues.createComment;
  state.github.rest.issues.createComment = async (params) => {
    const marker = claim.parseMarker(params.body, claim.STATE_MARKER);
    if (params.issue_number === 120 && marker?.status === 'reconciling') {
      throw new Error('PR comment unavailable');
    }
    return originalCreate(params);
  };

  await assert.rejects(reconcile(state, 120, { body: 'Tracks #20' }), /PR comment unavailable/);
  assert.equal(state.calls.addAssignees.length, 0);
  assert.deepEqual(state.issues.get(20).assignees, []);
  assert.equal(state.commentsFor(20).length, 0);
});

test('an interrupted final state write is recovered and released on unmerged close', async () => {
  const state = fixture();
  state.addIssue(21);
  state.addPull(121);
  const originalUpdate = state.github.rest.issues.updateComment;
  let failActiveStateOnce = true;
  state.github.rest.issues.updateComment = async (params) => {
    const marker = claim.parseMarker(params.body, claim.STATE_MARKER);
    if (marker?.status === 'active' && failActiveStateOnce) {
      failActiveStateOnce = false;
      throw new Error('final PR state unavailable');
    }
    return originalUpdate(params);
  };

  await assert.rejects(
    reconcile(state, 121, { body: 'Tracks #21' }),
    /final PR state unavailable/,
  );
  assert.equal(markerFor(state, 121, claim.STATE_MARKER, 121).status, 'reconciling');
  assert.equal(markerFor(state, 21, claim.ISSUE_MARKER, 121).managed, true);
  assert.deepEqual(state.issues.get(21).assignees.map((entry) => entry.login), [HUMAN.login]);

  await reconcile(state, 121, {
    action: 'closed', state: 'closed', merged: false, body: 'Tracks #21',
  });
  assert.deepEqual(state.issues.get(21).assignees, []);
  assert.equal(markerFor(state, 21, claim.ISSUE_MARKER, 121).status, 'released');
  assert.equal(markerFor(state, 121, claim.STATE_MARKER, 121).status, 'closed_unmerged');
});

test('an interrupted final state write is recovered when the tracked link is dropped', async () => {
  const state = fixture();
  state.addIssue(22);
  state.addPull(122);
  const originalUpdate = state.github.rest.issues.updateComment;
  let failActiveStateOnce = true;
  state.github.rest.issues.updateComment = async (params) => {
    const marker = claim.parseMarker(params.body, claim.STATE_MARKER);
    if (marker?.status === 'active' && failActiveStateOnce) {
      failActiveStateOnce = false;
      throw new Error('final PR state unavailable');
    }
    return originalUpdate(params);
  };

  await assert.rejects(reconcile(state, 122, { body: 'Tracks #22' }));
  await reconcile(state, 122, { action: 'edited', body: '' });

  assert.deepEqual(state.issues.get(22).assignees, []);
  assert.equal(markerFor(state, 22, claim.ISSUE_MARKER, 122).status, 'released');
  assert.deepEqual(markerFor(state, 122, claim.STATE_MARKER, 122).issues, {});
});

test('an interrupted issue-marker write leaves only non-removable journal state', async () => {
  const state = fixture();
  state.addIssue(23);
  state.addPull(123);
  const originalCreate = state.github.rest.issues.createComment;
  let failIssueMarkerOnce = true;
  state.github.rest.issues.createComment = async (params) => {
    const marker = claim.parseMarker(params.body, claim.ISSUE_MARKER);
    if (params.issue_number === 23 && marker && failIssueMarkerOnce) {
      failIssueMarkerOnce = false;
      throw new Error('issue marker unavailable');
    }
    return originalCreate(params);
  };

  await assert.rejects(reconcile(state, 123, { body: 'Tracks #23' }), /issue marker unavailable/);
  assert.equal(markerFor(state, 123, claim.STATE_MARKER, 123).status, 'reconciling');
  assert.equal(markerFor(state, 123, claim.STATE_MARKER, 123).issues['23'].managed, false);

  await reconcile(state, 123, {
    action: 'closed', state: 'closed', merged: false, body: 'Tracks #23',
  });
  assert.equal(state.calls.removeAssignees.length, 0);
  assert.deepEqual(state.issues.get(23).assignees.map((entry) => entry.login), [HUMAN.login]);
  assert.match(state.commentsFor(23)[0].body, /assignment was preserved/);
});

test('a bot issue marker without trusted PR state cannot authorize cleanup', async () => {
  const state = fixture();
  state.addIssue(24, [HUMAN.login]);
  state.addPull(124, 'closed');
  state.eventsFor(24).push({
    id: 4242,
    event: 'assigned',
    assignee: { login: HUMAN.login },
    actor: BOT,
    created_at: FIXED_NOW,
  });
  state.addComment(24, claim.issueCommentBody({
    pr: state.pulls.get(124),
    author: HUMAN.login,
    record: { managed: true, managedAt: FIXED_NOW, managedEventId: '4242' },
    status: 'active',
  }));

  const result = await reconcile(state, 124, {
    action: 'closed', state: 'closed', body: 'Tracks #24',
  });
  assert.equal(result.noPriorState, true);
  assert.equal(state.calls.removeAssignees.length, 0);
  assert.deepEqual(state.issues.get(24).assignees.map((entry) => entry.login), [HUMAN.login]);
});

test('twenty disjoint replacement links keep the recovery journal within its bound', async () => {
  const state = fixture();
  const first = Array.from({ length: claim.MAX_TRACKED_ISSUES }, (_, index) => 1001 + index);
  const second = Array.from({ length: claim.MAX_TRACKED_ISSUES }, (_, index) => 2001 + index);
  for (const number of [...first, ...second]) state.addIssue(number);
  state.addPull(140);
  const tracks = (numbers) => `Tracks ${numbers.map((number) => `#${number}`).join(', ')}`;

  await reconcile(state, 140, { body: tracks(first) });
  await reconcile(state, 140, { action: 'edited', body: tracks(second) });

  const marker = markerFor(state, 140, claim.STATE_MARKER, 140);
  assert.deepEqual(Object.keys(marker.issues).map(Number), second);
  assert.equal(Object.keys(marker.issues).length, claim.MAX_TRACKED_ISSUES);
  assert.deepEqual(
    state.calls.removeAssignees.map((entry) => entry.issue_number).sort((a, b) => a - b),
    first,
  );
  for (const number of second) {
    assert.deepEqual(state.issues.get(number).assignees.map((entry) => entry.login), [HUMAN.login]);
  }
});

test('transient issue validation failure cannot release an existing claim', async () => {
  const state = fixture();
  state.addIssue(8);
  state.addPull(108);

  await reconcile(state, 108, { body: 'Tracks #8' });
  const originalGet = state.github.rest.issues.get;
  state.github.rest.issues.get = async (params) => {
    if (params.issue_number === 8) {
      throw Object.assign(new Error('temporary service outage'), { status: 503 });
    }
    return originalGet(params);
  };

  await assert.rejects(
    reconcile(state, 108, { action: 'edited', body: 'Tracks #8' }),
    /Could not safely validate tracked issue #8/,
  );
  assert.equal(state.calls.removeAssignees.length, 0);
  assert.deepEqual(state.issues.get(8).assignees.map((entry) => entry.login), [HUMAN.login]);
  assert.equal(markerFor(state, 8, claim.ISSUE_MARKER, 108).status, 'active');
  assert.equal(markerFor(state, 108, claim.STATE_MARKER, 108).status, 'active');
});

test('cross-repository closing references cannot claim a same-number local issue', async () => {
  const state = fixture();
  const log = core();
  state.addIssue(12);
  state.addPull(112);
  state.closing.set(112, [{ number: 12, repository: 'maximyz3d/another-project' }]);

  const result = await reconcile(state, 112, { core: log });

  assert.deepEqual(result.issues, {});
  assert.deepEqual(state.issues.get(12).assignees, []);
  assert.equal(state.calls.addAssignees.length, 0);
  assert.match(log.infos.join('\n'), /Ignoring cross-repository closing reference #12/);
});

test('reconciliation uses current REST state instead of a stale queued event snapshot', async () => {
  const state = fixture();
  state.addIssue(10);
  state.addPull(110);
  await reconcile(state, 110, { body: 'Tracks #10' });

  Object.assign(state.pulls.get(110), { state: 'closed', merged: false });
  const result = await reconcile(state, 110, {
    action: 'edited', state: 'open', body: 'Tracks #10', syncPull: false,
  });

  assert.equal(result.status, 'closed_unmerged');
  assert.deepEqual(state.issues.get(10).assignees, []);
  assert.equal(state.calls.removeAssignees.length, 1);
  assert.equal(markerFor(state, 10, claim.ISSUE_MARKER, 110).status, 'released');
});

test('reconciliation uses the current REST body instead of restoring a stale tracked link', async () => {
  const state = fixture();
  state.addIssue(11);
  state.addPull(111);
  await reconcile(state, 111, { body: 'Tracks #11' });

  state.pulls.get(111).body = '';
  await reconcile(state, 111, {
    action: 'edited', body: 'Tracks #11', syncPull: false,
  });

  assert.deepEqual(state.issues.get(11).assignees, []);
  assert.equal(state.calls.removeAssignees.length, 1);
  assert.equal(markerFor(state, 11, claim.ISSUE_MARKER, 111).status, 'released');
});

test('an unmerged close preserves a pre-existing manual assignment', async () => {
  const state = fixture();
  state.addIssue(3, [HUMAN.login, 'maintainer']);
  state.addPull(102);

  await reconcile(state, 102, { body: 'Tracks #3' });
  assert.equal(markerFor(state, 3, claim.ISSUE_MARKER, 102).managed, false);
  state.pulls.get(102).state = 'closed';
  await reconcile(state, 102, { action: 'closed', state: 'closed', body: 'Tracks #3' });

  assert.equal(state.calls.removeAssignees.length, 0);
  assert.deepEqual(state.issues.get(3).assignees.map((entry) => entry.login), [HUMAN.login, 'maintainer']);
  assert.match(state.commentsFor(3)[0].body, /assignment was preserved/);
});

test('shared workflow ownership keeps the assignment until the final open claim closes', async () => {
  const state = fixture();
  state.addIssue(4);
  state.addPull(201);
  state.addPull(202);

  await reconcile(state, 201, { body: 'Tracks #4' });
  await reconcile(state, 202, { body: 'Tracks #4' });
  assert.equal(markerFor(state, 4, claim.ISSUE_MARKER, 202).managed, true);

  state.pulls.get(201).state = 'closed';
  await reconcile(state, 201, { action: 'closed', state: 'closed', body: 'Tracks #4' });
  assert.deepEqual(state.issues.get(4).assignees.map((entry) => entry.login), [HUMAN.login]);
  assert.equal(state.calls.removeAssignees.length, 0, 'the second open claim still owns the assignment');

  state.pulls.get(202).state = 'closed';
  await reconcile(state, 202, { action: 'closed', state: 'closed', body: 'Tracks #4' });
  assert.deepEqual(state.issues.get(4).assignees, []);
  assert.equal(state.calls.removeAssignees.length, 1);
});

test('a completed managed claim permanently retains an assignment shared with a later closed claim', async () => {
  const state = fixture();
  state.addIssue(14);
  state.addPull(214);
  state.addPull(215);

  await reconcile(state, 214, { body: 'Tracks #14' });
  await reconcile(state, 215, { body: 'Tracks #14' });
  await reconcile(state, 214, {
    action: 'closed', state: 'closed', merged: true, body: 'Tracks #14',
  });
  await reconcile(state, 215, {
    action: 'closed', state: 'closed', merged: false, body: 'Tracks #14',
  });

  assert.deepEqual(state.issues.get(14).assignees.map((entry) => entry.login), [HUMAN.login]);
  assert.equal(state.calls.removeAssignees.length, 0);
  assert.equal(markerFor(state, 14, claim.ISSUE_MARKER, 214).status, 'completed');
  assert.equal(markerFor(state, 14, claim.ISSUE_MARKER, 215).status, 'released');
});

test('completed retention is scoped to one uninterrupted assignment generation', async () => {
  const state = fixture();
  state.addIssue(16);
  state.addPull(216);
  state.addPull(217);

  await reconcile(state, 216, { body: 'Tracks #16' });
  await reconcile(state, 216, {
    action: 'closed', state: 'closed', merged: true, body: 'Tracks #16',
  });
  const completedGeneration = markerFor(state, 16, claim.ISSUE_MARKER, 216).managedEventId;

  state.issues.get(16).assignees = [];
  state.eventsFor(16).push({
    id: 9001,
    event: 'unassigned',
    assignee: { login: HUMAN.login },
    actor: { login: 'maintainer', type: 'User' },
    created_at: '2026-09-04T12:10:00.000Z',
  });
  await reconcile(state, 217, { body: 'Tracks #16' });
  const freshGeneration = markerFor(state, 16, claim.ISSUE_MARKER, 217).managedEventId;
  assert.notEqual(freshGeneration, completedGeneration);

  await reconcile(state, 217, {
    action: 'closed', state: 'closed', merged: false, body: 'Tracks #16',
  });
  assert.deepEqual(state.issues.get(16).assignees, []);
  assert.equal(state.calls.removeAssignees.length, 1);
});

test('a manual assignment racing addAssignees is never claimed as workflow-owned', async () => {
  const state = fixture();
  state.addIssue(15);
  state.addPull(315);
  const originalAdd = state.github.rest.issues.addAssignees;
  state.github.rest.issues.addAssignees = async (params) => {
    state.issues.get(15).assignees.push({ login: HUMAN.login });
    state.eventsFor(15).push({
      id: 9999,
      event: 'assigned',
      assignee: { login: HUMAN.login },
      actor: { login: 'maintainer', type: 'User' },
      created_at: '2026-09-04T12:00:00.500Z',
    });
    return originalAdd(params);
  };

  await reconcile(state, 315, { body: 'Tracks #15' });
  assert.equal(markerFor(state, 15, claim.ISSUE_MARKER, 315).managed, false);

  await reconcile(state, 315, {
    action: 'closed', state: 'closed', merged: false, body: 'Tracks #15',
  });
  assert.equal(state.calls.removeAssignees.length, 0);
  assert.deepEqual(state.issues.get(15).assignees.map((entry) => entry.login), [HUMAN.login]);
});

test('a manual reassignment racing final removal is detected and restored', async () => {
  const state = fixture();
  state.addIssue(18);
  state.addPull(318);
  await reconcile(state, 318, { body: 'Tracks #18' });

  const originalRemove = state.github.rest.issues.removeAssignees;
  state.github.rest.issues.removeAssignees = async (params) => {
    state.eventsFor(18).push({
      id: 9998,
      event: 'assigned',
      assignee: { login: HUMAN.login },
      actor: { login: 'maintainer', type: 'User' },
      created_at: '2026-09-04T12:15:00.000Z',
    });
    return originalRemove(params);
  };

  await reconcile(state, 318, {
    action: 'closed', state: 'closed', merged: false, body: 'Tracks #18',
  });
  assert.equal(state.calls.removeAssignees.length, 1);
  assert.deepEqual(state.issues.get(18).assignees.map((entry) => entry.login), [HUMAN.login]);
  assert.match(state.commentsFor(18)[0].body, /assignment was preserved/);
});

test('a later manual assignment event prevents workflow cleanup from removing the author', async () => {
  const state = fixture();
  state.addIssue(5);
  state.addPull(301);

  await reconcile(state, 301, { body: 'Tracks #5' });
  state.eventsFor(5).push({
    event: 'assigned',
    assignee: { login: HUMAN.login },
    actor: { login: 'maintainer', type: 'User' },
    created_at: '2026-09-04T12:05:00.000Z',
  });
  state.pulls.get(301).state = 'closed';
  await reconcile(state, 301, { action: 'closed', state: 'closed', body: 'Tracks #5' });

  assert.equal(state.calls.removeAssignees.length, 0);
  assert.deepEqual(state.issues.get(5).assignees.map((entry) => entry.login), [HUMAN.login]);
});

test('a merged PR completes marker comments without releasing assignments', async () => {
  const state = fixture();
  state.addIssue(6);
  state.addPull(401);

  await reconcile(state, 401, { body: 'Tracks #6' });
  state.pulls.get(401).state = 'closed';
  const result = await reconcile(state, 401, {
    action: 'closed', state: 'closed', merged: true, body: 'Tracks #6',
  });

  assert.equal(result.status, 'merged');
  assert.equal(state.calls.removeAssignees.length, 0);
  assert.deepEqual(state.issues.get(6).assignees.map((entry) => entry.login), [HUMAN.login]);
  assert.equal(markerFor(state, 6, claim.ISSUE_MARKER, 401).status, 'completed');
});

test('merge releases a claim removed from the current body before its edit run', async () => {
  const state = fixture();
  state.addIssue(17);
  state.addPull(417);
  await reconcile(state, 417, { body: 'Tracks #17' });

  Object.assign(state.pulls.get(417), { body: '', state: 'closed', merged: true });
  const result = await reconcile(state, 417, {
    action: 'closed', body: 'Tracks #17', state: 'closed', merged: true, syncPull: false,
  });

  assert.equal(result.status, 'merged');
  assert.deepEqual(result.issues, {});
  assert.deepEqual(state.issues.get(17).assignees, []);
  assert.equal(markerFor(state, 17, claim.ISSUE_MARKER, 417).status, 'released');
});

test('untrusted marker comments cannot authorize assignment removal', async () => {
  const state = fixture();
  state.addIssue(7, [HUMAN.login]);
  state.addPull(501, 'closed');
  const spoofed = claim.markerLine(claim.STATE_MARKER, {
    v: 1,
    pr: 501,
    author: HUMAN.login,
    status: 'active',
    issues: { 7: { managed: true, managedAt: FIXED_NOW } },
  });
  state.addComment(501, spoofed, HUMAN);

  const result = await reconcile(state, 501, {
    action: 'closed', state: 'closed', body: 'Tracks #7',
  });
  assert.equal(result.noPriorState, true);
  assert.equal(state.calls.removeAssignees.length, 0);
  assert.deepEqual(state.issues.get(7).assignees.map((entry) => entry.login), [HUMAN.login]);
});
