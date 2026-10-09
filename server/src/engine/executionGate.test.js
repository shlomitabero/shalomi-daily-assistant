import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExecutionGate } from './executionGate.js';

test('emergency stop blocks everything regardless of mode', () => {
  assert.equal(checkExecutionGate({ mode: 'auto_limited', emergencyStop: true, hasApproval: true }).allowed, false);
});

test('research mode never allows execution, even with an approval', () => {
  const result = checkExecutionGate({ mode: 'research', emergencyStop: false, hasApproval: true });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /research mode/);
});

test('approve mode blocks without an explicit approval', () => {
  const result = checkExecutionGate({ mode: 'approve', emergencyStop: false, hasApproval: false });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /approval/);
});

test('approve mode allows once this specific action has an approval', () => {
  const result = checkExecutionGate({ mode: 'approve', emergencyStop: false, hasApproval: true });
  assert.equal(result.allowed, true);
});

test('auto_limited mode allows without a per-action approval', () => {
  const result = checkExecutionGate({ mode: 'auto_limited', emergencyStop: false, hasApproval: false });
  assert.equal(result.allowed, true);
});

test('an unrecognized mode is rejected rather than defaulting to allowed', () => {
  const result = checkExecutionGate({ mode: 'yolo', emergencyStop: false, hasApproval: true });
  assert.equal(result.allowed, false);
});
