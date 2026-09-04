'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const qs = require('qs');
const qsPackage = require('qs/package.json');

test('qs override keeps the patched parser and serializer behavior', () => {
  assert.equal(qsPackage.version, '6.16.0');

  assert.throws(() => qs.parse('a[]=1,2,3,4', {
    comma: true,
    arrayLimit: 3,
    throwOnLimitExceeded: true,
  }), RangeError);

  const attackerControlled = qs.parse(
    'x%5Bconstructor%5D%5BisBuffer%5D=y',
    { plainObjects: true },
  );
  assert.doesNotThrow(() => qs.stringify(attackerControlled));
});
