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

  // The base fleet width for a single-account install. Unchanged at 8; only the
  // env ceiling moved, so an operator running many linked plans can widen the
  // fleet deliberately instead of being capped at twice the default.
  const maxActiveOneShots = limit('MAX_ACTIVE_ONESHOTS', 8, 64);
  const maxActivePerProvider = limit('MAX_ACTIVE_PER_PROVIDER', 4, Math.min(4, maxActiveOneShots));
  return {
    maxActiveOneShots,
    maxActivePerProvider,
    // The real rate-limit boundary is one authenticated login, not one provider
    // key. Two Claude plans are two allowances with two independent limits, so
    // each gets its own slots and the provider ceiling becomes the sum. Defaults
    // to the per-provider limit, which makes a single-account seat identical to
    // what it was before accounts could be pooled.
    maxActivePerAccount: limit('MAX_ACTIVE_PER_ACCOUNT', maxActivePerProvider, maxActiveOneShots),
    // Absolute machine-wide stop. Reached only by scaling below, never by the
    // base default, so no existing install changes width by upgrading.
    oneShotCapacityCeiling: limit('ONESHOT_CAPACITY_CEILING', 32, 64),
    maxConcurrentTasks: limit('MAX_TASKS', 8, maxActiveOneShots),
  };
}

// How wide the fleet may run right now.
//
// Linked accounts are extra allowances, so each one the operator actually signed
// in raises the machine-wide cap by one account's worth of slots. `linkedCount`
// counts EXPLICIT accounts only — a pristine install has none and keeps exactly
// its configured width, which is why upgrading changes nothing until a second
// plan is linked.
function scaleOneShotCapacity({ base, perAccount, linkedAccountCount = 0, ceiling } = {}) {
  const width = Number.isSafeInteger(base) && base > 0 ? base : 1;
  const per = Number.isSafeInteger(perAccount) && perAccount > 0 ? perAccount : 1;
  const linked = Number.isSafeInteger(linkedAccountCount) && linkedAccountCount > 0 ? linkedAccountCount : 0;
  const top = Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : width;
  return Math.max(width, Math.min(top, width + per * linked));
}

// The concurrency ceiling for one provider key: one account's worth of slots per
// usable account, never wider than the whole fleet.
function providerCapacity({ perAccount, usableAccountCount = 1, fleetCapacity } = {}) {
  const per = Number.isSafeInteger(perAccount) && perAccount > 0 ? perAccount : 1;
  const usable = Number.isSafeInteger(usableAccountCount) && usableAccountCount > 0 ? usableAccountCount : 1;
  const fleet = Number.isSafeInteger(fleetCapacity) && fleetCapacity > 0 ? fleetCapacity : per * usable;
  return Math.max(1, Math.min(fleet, per * usable));
}

module.exports = { resolveConcurrencyPolicy, scaleOneShotCapacity, providerCapacity };
