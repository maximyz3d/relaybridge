import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const POLICY_PATH = path.join(ROOT, 'config', 'routing-policy.json');
const EVIDENCE_PATH = path.join(ROOT, 'config', 'provider-evidence.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

export function loadRoutingData() {
  const policyBytes = fs.readFileSync(POLICY_PATH);
  const evidenceBytes = fs.readFileSync(EVIDENCE_PATH);
  return {
    policy: JSON.parse(policyBytes.toString('utf8')),
    evidence: JSON.parse(evidenceBytes.toString('utf8')),
    fingerprints: {
      policySha256: crypto.createHash('sha256').update(policyBytes).digest('hex'),
      evidenceSha256: crypto.createHash('sha256').update(evidenceBytes).digest('hex'),
    },
  };
}

export function classifyTask(task) {
  const raw = String(task || '').trim();
  if (!raw) throw new Error('task must be a non-empty string');
  const text = raw.toLowerCase();
  const tags = new Set();

  const looksLikeCode = hasAny(text, [
    /```/, /\b(implement|debug|refactor|compile|test failure|stack trace|function|class|typescript|javascript|python|rust|golang|repository|codebase|pull request|\bpr\b)\b/,
    /\.(?:js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|cs|cpp|h|ps1|json|toml|ya?ml)\b/,
  ]);
  const looksLikeReview = hasAny(text, [
    /\b(review|audit|critique|verify|regression|security review|design review|drc|lint)\b/,
  ]);
  const looksLikeResearch = hasAny(text, [
    /\b(latest|current|research|browse|search the web|sources?|citations?|evidence|compare products?|github projects?)\b/,
  ]);
  const looksLikeReasoning = hasAny(text, [
    /\b(prove|proof|theorem|conjecture|formal reasoning|logic puzzle|mathematical reasoning|p\s*(?:=|equals?|vs\.?|versus)\s*np)\b/,
  ]);
  const looksLikeVision = hasAny(text, [
    /\b(image|screenshot|photo|diagram|render|visual|ocr|camera|pixel|layout)\b/,
  ]);
  const looksLikeHardware = hasAny(text, [
    /\b(pcb|kicad|schematic|gerber|motor|stator|rotor|rf|antenna|aircraft|avionics|obd|embedded|firmware|bom|fabrication)\b/,
  ]);
  const looksLikeDeterministic = hasAny(text, [
    /\b(git status|list files?|show files?|find files?|process list|health check|version|which command|where is|count lines?|hash|sha256|directory listing)\b/,
  ]);
  const looksLikeQuickLookup = raw.length <= 500 && hasAny(text, [
    /^\s*(what is|who is|define|spell|translate|convert|list|show|find|where|when|how many)\b/,
    /\b(dictionary|definition|spelling|unit conversion)\b/,
  ]);
  const destructive = hasAny(text, [
    /\b(remove recursively|wipe|erase|drop database|force push|reset --hard|overwrite|terminate all|kill all|factory reset)\b/,
    /\b(?:delete|remove)\s+(?:all\s+|the\s+)?(?:files?|directories|folders|databases?|records?|credentials?|keys?|branches)\b/,
    /\brotate\s+(?:the\s+)?(?:production\s+)?(?:signing|encryption|api|access)?\s*keys?\b/,
    /\b(?:deploy\b.*\bproduction|production\b.*\bdeploy)\b/,
  ]);
  const medical = /\b(medical|diagnosis|patient|prescription|dosage)\b/.test(text);
  const legal = /\b(legal|lawsuit|attorney|criminal charge|court filing)\b/.test(text);
  const financial = /\b(financial advice|investment decision|trade execution|retirement allocation)\b/.test(text);
  const secrets = /\b(credentials?|api keys?|access tokens?|passwords?|secrets?|signing keys?|encryption keys?)\b/.test(text);
  const safetyCritical = /\b(airworthy|flight[- ]ready|life safety|safety[- ]critical|production release|fabrication release)\b/.test(text);
  const highStakes = medical || legal || financial || secrets || safetyCritical;

  if (looksLikeCode) tags.add('coding');
  if (looksLikeReview) tags.add(looksLikeCode ? 'code_review' : 'reasoning');
  if (looksLikeResearch) tags.add('research');
  if (looksLikeReasoning) tags.add('reasoning');
  if (looksLikeVision) tags.add('vision');
  if (looksLikeHardware) tags.add('hardware');
  if (looksLikeDeterministic) tags.add('deterministic');
  if (looksLikeQuickLookup) tags.add('quick_lookup');
  if (destructive) tags.add('destructive');
  if (medical) tags.add('medical');
  if (legal) tags.add('legal');
  if (financial) tags.add('financial');
  if (secrets) tags.add('secrets');
  if (safetyCritical) tags.add('safety_critical');
  if (!tags.size) tags.add('general');

  const conjunctions = (text.match(/\b(and|also|then|plus|as well as|lastly|finally)\b/g) || []).length;
  const requirements = (text.match(/\b(must|should|need to|has to|require)\b/g) || []).length;
  const estimated = estimateTokens(raw);
  let tier = 'utility';
  const reasons = [];

  if (destructive || highStakes) {
    tier = 'critical';
    reasons.push('high-stakes or destructive signal');
  } else if (
    raw.length > 8000 || estimated > 2000 || conjunctions >= 5 || requirements >= 5 ||
    hasAny(text, [/\b(architecture|migration|threat model|root cause|cross[- ]module|multi[- ]agent|release readiness|p\s*(?:=|equals?|vs\.?|versus)\s*np|unsolved conjecture)\b/])
  ) {
    tier = 'complex';
    reasons.push('long, multi-part, or architectural task');
  } else if (looksLikeCode || looksLikeResearch || looksLikeReasoning || looksLikeHardware || raw.length > 1000 || conjunctions >= 2) {
    tier = 'standard';
    reasons.push('specialized or multi-step task');
  } else {
    reasons.push('short bounded task');
  }

  if (looksLikeQuickLookup || looksLikeDeterministic) reasons.push('eligible for a cheap or deterministic first route');
  if (looksLikeResearch) reasons.push('requires a source-capable route and freshness controls');

  const domainTags = [...tags].filter((tag) => !['destructive', 'medical', 'legal', 'financial', 'secrets', 'safety_critical'].includes(tag));
  const confidence = domainTags.includes('general') ? 'low'
    : domainTags.length <= 2 ? 'high'
      : 'medium';

  return {
    task: raw,
    taskHash: crypto.createHash('sha256').update(raw).digest('hex'),
    estimatedInputTokens: estimated,
    inputChars: raw.length,
    tags: [...tags],
    tier,
    signals: {
      conjunctions,
      requirements,
      destructive,
      highStakes,
    },
    routingConfidence: {
      level: confidence,
      basis: confidence === 'low'
        ? 'No task-family signal matched; retain escalation headroom.'
        : 'One or more explicit task-family signals matched the deterministic classifier.',
    },
    reasons,
  };
}

function tierRank(tier) {
  return ['utility', 'standard', 'complex', 'critical'].indexOf(tier);
}

function readinessFor(kind, diagnostics) {
  const info = diagnostics && diagnostics[kind];
  if (!info) return { found: null, ready: null, detail: 'not probed in this route preview' };
  return {
    found: !!info.found,
    ready: !!info.ready,
    detail: String(info.detail || ''),
  };
}

function qualificationWeight(level) {
  return {
    benchmark_reproduced: 20,
    task_evaluated: 16,
    local_smoke: 10,
    available: 5,
    discovered: 1,
  }[level] || 0;
}

export function routeTask({
  task,
  diagnostics = {},
  preferredProviders = [],
  excludedProviders = [],
  localOnly = false,
  maxProviders,
  committeeMode = 'advisory',
} = {}) {
  const classification = classifyTask(task);
  const { policy, evidence, fingerprints } = loadRoutingData();
  const excluded = new Set(excludedProviders);
  const preferred = new Set(preferredProviders);
  const neverAuto = classification.tags.filter((tag) => policy.neverAutoExecuteTags.includes(tag));
  const primaryTag = [
    'deterministic', 'research', 'code_review', 'coding', 'vision', 'hardware', 'quick_lookup', 'reasoning', 'general',
  ].find((tag) => classification.tags.includes(tag)) || 'general';
  const priority = policy.taskPriorities[primaryTag] || policy.taskPriorities.general;

  const candidates = Object.entries(evidence.providers).map(([kind, provider]) => {
    const ready = readinessFor(kind, diagnostics);
    const priorityIndex = priority.indexOf(kind);
    let policyScore = priorityIndex >= 0 ? 100 - priorityIndex * 8 : 10;
    const reasons = [];
    const limitations = [...(provider.limitations || [])];
    const capabilityMatch = (provider.capabilities || []).filter((tag) => classification.tags.includes(tag));
    const requiredCapability = ['vision', 'research'].includes(primaryTag) ? primaryTag : null;

    if (preferred.has(kind)) {
      policyScore += 1000;
      reasons.push('explicitly preferred by caller');
    }
    if (capabilityMatch.length) {
      policyScore += 25 + capabilityMatch.length * 3;
      reasons.push(`registry tags match: ${capabilityMatch.join(', ')}`);
    }
    if (requiredCapability && !(provider.capabilities || []).includes(requiredCapability)) {
      policyScore -= 10000;
      reasons.push(`missing required capability: ${requiredCapability}`);
    }
    if (policy.localFirstProviders.includes(kind) && classification.tier === 'utility') {
      policyScore += 30;
      reasons.push('local-first utility route');
    }
    if (
      policy.lowConfidenceMode === 'fail_up' &&
      classification.routingConfidence.level === 'low' &&
      classification.tier !== 'utility' &&
      policy.localFirstProviders.includes(kind)
    ) {
      policyScore -= 30;
      reasons.push('low-confidence fail-up keeps a stronger-route margin');
    }
    policyScore += qualificationWeight(provider.qualification);
    reasons.push(`qualification=${provider.qualification}`);

    if (provider.maxRecommendedTier && tierRank(classification.tier) > tierRank(provider.maxRecommendedTier)) {
      policyScore -= 70;
      limitations.push(`Policy limits this route to ${provider.maxRecommendedTier} without escalation evidence.`);
    }
    if (ready.ready === false) {
      policyScore -= 10000;
      reasons.push('live diagnostic is not ready');
    } else if (ready.ready === true) {
      policyScore += 20;
      reasons.push('live diagnostic ready');
    }
    if (localOnly && !String(provider.privacyBoundary).startsWith('local')) {
      policyScore -= 10000;
      reasons.push('excluded by local-only policy');
    }
    if (excluded.has(kind)) {
      policyScore -= 10000;
      reasons.push('explicitly excluded by caller');
    }

    return {
      kind,
      family: provider.family,
      modelIdentity: provider.modelIdentity,
      costClass: provider.costClass,
      privacyBoundary: provider.privacyBoundary,
      qualification: provider.qualification,
      capabilities: provider.capabilities || [],
      evidence: provider.evidence || [],
      limitations,
      readiness: ready,
      policyScore,
      policyReasons: reasons,
    };
  }).sort((a, b) => b.policyScore - a.policyScore || a.kind.localeCompare(b.kind));

  const tierLimit = policy.tiers[classification.tier].maxProviders;
  const requestedLimit = Number.isInteger(maxProviders) ? Math.max(1, maxProviders) : tierLimit;
  const limit = Math.min(requestedLimit, tierLimit, policy.committee.maxProviders);
  const selected = [];
  const families = new Set();

  for (const candidate of candidates) {
    if (candidate.policyScore < 0) continue;
    if (selected.length >= limit) break;
    if (selected.length > 0 && families.has(candidate.family) && candidates.some((other) => (
      other.policyScore >= 0 && !families.has(other.family) && !selected.includes(other)
    ))) continue;
    selected.push(candidate);
    families.add(candidate.family);
  }
  const roleNames = committeeMode === 'consensus'
    ? ['primary', 'critic', 'researcher', 'verifier']
    : ['primary', 'critic', 'researcher', 'verifier'];
  const plan = selected.map((candidate, index) => ({
    ...candidate,
    role: roleNames[Math.min(index, roleNames.length - 1)],
  }));

  return {
    routeId: `route_${Date.now().toString(36)}_${classification.taskHash.slice(0, 10)}`,
    generatedAt: new Date().toISOString(),
    policyMode: policy.mode,
    classification,
    primaryTag,
    humanGateRequired: neverAuto.length > 0,
    humanGateReasons: neverAuto,
    selected: plan,
    noEligibleRoute: plan.length === 0,
    candidates,
    evidenceUpdatedAt: evidence.updatedAt,
    registryFingerprints: fingerprints,
    qualificationBoundary: evidence.qualificationPolicy.rule,
    note: 'policyScore is an operator routing preference, not a universal model-quality score',
  };
}
