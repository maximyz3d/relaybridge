'use strict';

// Wire contract identity.
//
// The build hash answers "is this the same source tree?". That is a stricter
// question than the one the MCP preflight actually needs, which is "do these
// two processes agree on the protocol between them?". Every rebuild moves the
// build hash, so editing a comment stranded every connected MCP client exactly
// as hard as changing the execution contract did — and the operator could not
// tell the two apart from the error.
//
// This digest covers only the shared surfaces the MCP client and the bridge
// must agree on. It moves when one of those changes and stays put otherwise, so
// a build-hash-only difference can be reported as drift and allowed to proceed
// while a real contract divergence still fails closed.
//
// Two rules for maintaining it:
//   1. If the MCP client validates against a list the bridge enforces, that
//      list belongs in SURFACES. Adding the surface is part of changing it.
//   2. Order is significant wherever order is meaningful. SUPPORTED_EFFORTS is
//      a ladder that step-downs walk, so a reordering IS a contract change and
//      must not be normalised away.

const crypto = require('node:crypto');
const { CONTRACT_FIELDS, TASK_TIERS, MODEL_TIERS } = require('./execution-contract');
const { SUPPORTED_EFFORTS, EXTREME_EFFORTS, EFFORT_BY_TASK_TIER } = require('./effort-controls');

const SURFACES = {
  // The execution contract both sides construct, validate and fingerprint.
  executionContractFields: CONTRACT_FIELDS,
  // Enums that appear in MCP tool schemas and in bridge-side validation. A
  // client whose enum lacks a level the bridge accepts rejects valid work
  // locally; the reverse sends a level the bridge refuses.
  supportedEfforts: SUPPORTED_EFFORTS,
  extremeEfforts: [...EXTREME_EFFORTS].sort(),
  effortByTaskTier: EFFORT_BY_TASK_TIER,
  taskTiers: TASK_TIERS,
  modelTiers: MODEL_TIERS,
};

// Deterministic serialisation: object keys sorted, array order preserved.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  }
  return value;
}

function wireContractSurfaces() { return stable(SURFACES); }

function wireContractId() {
  return crypto.createHash('sha256').update(JSON.stringify(stable(SURFACES))).digest('hex').slice(0, 16);
}

module.exports = { wireContractId, wireContractSurfaces, SURFACES };
