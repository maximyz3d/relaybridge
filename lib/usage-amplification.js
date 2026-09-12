'use strict';

// Advisory only. Reused cached context is real provider usage, but is not new
// output and never becomes an inferred subscription quota or a hard turn cap.
function usageAmplification({ cacheReadTokens, cacheCreationTokens = 0, cacheInputIncluded = false, inputTokens, outputTokens, turns } = {}) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const cache = count(cacheReadTokens), input = count(inputTokens), output = count(outputTokens), turnCount = count(turns);
  const created = count(cacheCreationTokens);
  const uncached = input !== null && (!cacheInputIncluded || cache !== null && created !== null)
    ? Math.max(0, input - (cacheInputIncluded ? cache + created : 0)) : null;
  // Newly created cache is input work; only repeated cache reads amplify it.
  const ratio = cache !== null && uncached !== null && output !== null && created !== null
    ? cache / Math.max(1, uncached + created + output) : null;
  const high = cache !== null && cache >= 1000000 && ratio !== null && ratio >= 50;
  return { policy: 'cache-amplification-v1', action: high ? 'review_efficiency' : 'none', advisory: true,
    cacheReadTokens: cache, turns: turnCount, cacheToUncachedRatio: ratio === null ? null : Math.round(ratio * 100) / 100,
    repeatedTurnAmplification: high && turnCount !== null && turnCount >= 32,
    threshold: { cacheReadTokens: 1000000, cacheToUncachedRatio: 50, turns: 32 },
    source: 'provider_reported', automaticStop: false };
}
module.exports = { usageAmplification };
