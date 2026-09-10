'use strict';

// Resolve all three admission limits together so background dispatch and
// direct provider calls share a bounded, observable capacity policy.
function resolveConcurrencyPolicy(env = process.env) {
  function limit(name, fallback, ceiling) {
    const raw = [env[`RELAYBRIDGE_${name}`], env[`PS_BRIDGE_${name}`]]
      .find((value) => value !== undefined && String(value).trim() !== '');
    const value = Number(raw);
    return Math.min(Number.isSafeInteger(value) && value > 0 ? value : fallback, ceiling);
  }

  const maxActiveOneShots = limit('MAX_ACTIVE_ONESHOTS', 8, 16);
  return {
    maxActiveOneShots,
    maxActivePerProvider: limit('MAX_ACTIVE_PER_PROVIDER', 4, Math.min(4, maxActiveOneShots)),
    maxConcurrentTasks: limit('MAX_TASKS', 8, maxActiveOneShots),
  };
}

module.exports = { resolveConcurrencyPolicy };
