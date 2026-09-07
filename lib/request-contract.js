'use strict';

// Shared REST/MCP boundaries. Ledger assertions never constitute execution or
// independent verification of the milestone they describe.
const { z } = require('zod');
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/+-]*$/);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const create = z.object({ requestId: id, actor: id,
  requirements: z.array(z.object({ requirementId: id, summary: z.string().min(1).max(600) }).strict()).min(1).max(64),
}).strict();
const link = z.object({ runId: id, actor: id }).strict();
const evidence = z.object({ eventId: id, requirementId: id, actor: id, revision,
  milestone: z.enum(['planned', 'implemented', 'tested', 'approved', 'merged', 'deployed']),
  outcome: z.enum(['confirmed', 'rejected', 'missing']),
  evidence: z.array(z.object({ kind: z.enum(['artifact', 'test', 'review', 'merge', 'deployment', 'incident', 'receipt']),
    ref: id, digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).max(16),
  reason: z.string().min(1).max(600).optional(),
  correlation: z.object(Object.fromEntries(['runId', 'taskId', 'incidentId', 'receiptId', 'invocationId', 'attemptId']
    .map((key) => [key, id.optional()]))).strict().optional(),
}).strict();
module.exports = { id, revision, create, link, evidence };
