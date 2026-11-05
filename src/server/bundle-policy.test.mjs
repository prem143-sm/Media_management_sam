import test from 'node:test';
import assert from 'node:assert/strict';
import { planPhotoBundles } from './bundle-policy.mjs';

const MB = 1024 * 1024;
const current = [{ id: 'bundle-001', path: 'photos/bundle-001/', photoCount: 1, sizeBytes: 95 * MB }];

test('a photo that fits stays in the current bundle', () => {
  const result = planPhotoBundles(current, [4 * MB], 100 * MB);
  assert.deepEqual(result.assignments, ['bundle-001']);
  assert.equal(result.bundles[0].sizeBytes, 99 * MB);
});

test('a photo that would exceed the limit starts a new bundle', () => {
  const result = planPhotoBundles(current, [10 * MB], 100 * MB);
  assert.deepEqual(result.assignments, ['bundle-002']);
  assert.equal(result.bundles[0].sizeBytes, 95 * MB);
  assert.equal(result.bundles[1].sizeBytes, 10 * MB);
});

test('a batch rolls to the next bundle when the running total crosses the limit', () => {
  const result = planPhotoBundles(current, [3 * MB, 3 * MB, 96 * MB, 1 * MB], 100 * MB);
  assert.deepEqual(result.assignments, ['bundle-001', 'bundle-002', 'bundle-002', 'bundle-002']);
  assert.deepEqual(result.bundles.map((bundle) => bundle.sizeBytes), [98 * MB, 100 * MB]);
});

test('a file larger than the limit is rejected', () => {
  assert.throws(() => planPhotoBundles([], [101 * MB], 100 * MB), /exceeds the photo bundle limit/);
});
