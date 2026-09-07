'use strict';

function guardProviderInput(stream, onFailure) {
  if (!stream || typeof stream.on !== 'function') return false;
  stream.on('error', () => {
    if (typeof onFailure === 'function') onFailure();
  });
  return true;
}

module.exports = { guardProviderInput };
