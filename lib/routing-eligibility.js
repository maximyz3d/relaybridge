'use strict';

const fs = require('node:fs');
const path = require('node:path');
const TIER_ORDER = ['utility', 'standard', 'complex', 'critical'];

function loadAptitudes() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'provider-evidence.json'), 'utf8')).providers;
}

function primaryTaskFamily(classification = {}) {
  if (classification.signals?.whollyDeterministic || classification.tier === 'deterministic') return 'deterministic';
  const tags = classification.tags || [];
  return ['vision', 'research', 'code_review', 'coding', 'hardware', 'quick_lookup', 'reasoning', 'general']
    .find((tag) => tags.includes(tag)) || 'general';
}

// Eligibility is independent of scores and caller preferences. Capabilities
// describe the actual invocation surface; aptitude describes operator-approved
// task families/complexity, not a claimed universal benchmark ranking.
function hardEligibility({ kind, capabilities = [], aptitude = {}, classification = {}, modelTier } = {}) {
  const declared = Array.isArray(capabilities) ? capabilities : [];
  const modelInvocation = kind !== 'powershell' && declared.includes('model_invocation');
  const family = primaryTaskFamily(classification);
  const reasons = [];
  if (!modelInvocation && family !== 'deterministic') reasons.push('task requires model invocation; deterministic tools cannot perform semantic work');
  if (!modelInvocation && family === 'deterministic' && !(aptitude.capabilities || []).includes('deterministic')) reasons.push('missing deterministic execution capability');
  if (modelTier === 'heavy' && !modelInvocation) reasons.push('heavy model tier requires actual model invocation');
  if (['vision', 'research', 'code_review', 'coding'].includes(family) && !(aptitude.capabilities || []).includes(family)) {
    reasons.push(`missing required capability: ${family}`);
  }
  if (aptitude.maxRecommendedTier && TIER_ORDER.indexOf(classification.tier) > TIER_ORDER.indexOf(aptitude.maxRecommendedTier)) {
    reasons.push(`task exceeds approved ${aptitude.maxRecommendedTier} tier ceiling`);
  }
  return { eligible: reasons.length === 0, ineligibilityReasons: reasons, modelInvocation, taskFamily: family };
}

module.exports = { hardEligibility, primaryTaskFamily, loadAptitudes };
