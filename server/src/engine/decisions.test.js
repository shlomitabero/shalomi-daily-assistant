import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDecision } from './decisions.js';

test('fixed choice keys resolve directly without needing text', () => {
  assert.equal(resolveDecision({ choice: 'pay', employeeName: 'Alex' }).key, 'pay');
  assert.equal(resolveDecision({ choice: 'fire', employeeName: 'Alex' }).key, 'fire');
  assert.equal(resolveDecision({ choice: 'equity', employeeName: 'Alex' }).fired, false);
});

test('free text infers "negotiate" even though the word contains "go" (regression)', () => {
  // "negotiate" literally contains the substring "go" — a naive "let.*go"
  // match without word boundaries would misfire this as a firing decision.
  const outcome = resolveDecision({ freeText: "let's negotiate a smaller raise", employeeName: 'Alex' });
  assert.equal(outcome.key, 'negotiate');
});

test('free text infers "fire" from natural phrasing', () => {
  assert.equal(resolveDecision({ freeText: 'let him go', employeeName: 'Alex' }).key, 'fire');
  assert.equal(resolveDecision({ freeText: "I'm going to fire them", employeeName: 'Alex' }).key, 'fire');
  assert.equal(resolveDecision({ freeText: 'terminate the contract', employeeName: 'Alex' }).key, 'fire');
});

test('free text infers "equity" and "refuse"', () => {
  assert.equal(resolveDecision({ freeText: 'offer them some equity instead', employeeName: 'Alex' }).key, 'equity');
  assert.equal(resolveDecision({ freeText: 'no, I refuse', employeeName: 'Alex' }).key, 'refuse');
});

test('unrecognized free text defaults to "pay"', () => {
  assert.equal(resolveDecision({ freeText: 'sure, whatever works', employeeName: 'Alex' }).key, 'pay');
});

test('firing an employee sets fired:true and does not touch salary', () => {
  const outcome = resolveDecision({ choice: 'fire', employeeName: 'Alex' });
  assert.equal(outcome.fired, true);
  assert.equal(outcome.salaryMultiplier, 1);
});
