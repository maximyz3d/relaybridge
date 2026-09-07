'use strict';

// Bounds local submission/planning bursts, independently of provider admission
// and subscription quota. Polling and already accepted work remain unaffected.
const delegationRateLimitOptions = {
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Bridge delegation submission rate exceeded. No tasks from this request were accepted; retry after the Retry-After interval.',
    failureClass: 'bridge_request_rate_limit',
    accepted: false,
  },
};

module.exports = { delegationRateLimitOptions };
