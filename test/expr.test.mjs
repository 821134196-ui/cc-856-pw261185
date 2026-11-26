// Parser and validator behaviour, including error positions.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ExprError,
  parseExpression,
  stringifyExpression,
  validateExpression,
  daysInMonth,
} from '../server/expr.mjs';

test('parses a single comparison', () => {
  const ast = parseExpression("local_date(ts) = DATE '2026-03-08'");
  assert.equal(ast.type, 'compare');
  assert.equal(ast.field.name, 'local_date');
  assert.equal(ast.op, '=');
  assert.equal(ast.literal.type, 'date');
  assert.equal(ast.literal.text, '2026-03-08');
});

test('AND binds tighter than OR', () => {
  const ast = parseExpression(
    "local_date(ts) = DATE '2026-03-08' AND ts >= TS '2026-03-08T00:00:00Z' OR local_ts(ts) < WALL '2026-01-01 00:00:00'",
  );
  assert.equal(ast.type, 'or');
  assert.equal(ast.left.type, 'and');
});

test('parentheses override precedence', () => {
  const ast = parseExpression(
    "local_date(ts) = DATE '2026-03-08' AND (ts >= TS '2026-03-08T00:00:00Z' OR local_ts(ts) < WALL '2026-01-01 00:00:00')",
  );
  assert.equal(ast.type, 'and');
  assert.equal(ast.right.type, 'or');
});

test('parses BETWEEN and negated BETWEEN', () => {
  const ast = parseExpression("local_ts(ts) BETWEEN WALL '2026-11-01 01:00:00' AND WALL '2026-11-01 01:59:59'");
  assert.equal(ast.type, 'between');
  assert.equal(ast.negated, false);
  const neg = parseExpression("local_ts(ts) NOT BETWEEN WALL '2026-11-01 01:00:00' AND WALL '2026-11-01 01:59:59'");
  assert.equal(neg.negated, true);
});

test('parses IN lists with a single and many values', () => {
  const one = parseExpression("local_date(ts) IN (DATE '2026-03-08')");
  assert.equal(one.type, 'in');
  assert.equal(one.values.length, 1);
  const many = parseExpression("local_date(ts) IN (DATE '2026-03-08', DATE '2026-09-06', DATE '2026-11-01')");
  assert.equal(many.values.length, 3);
});

test('parses TS literals with fractional seconds and explicit offsets', () => {
  const ast = parseExpression("ts >= TS '2026-03-08T01:02:03.500+05:30'");
  assert.equal(ast.literal.type, 'instant');
  assert.equal(ast.literal.fracUs, 500000);
  assert.equal(ast.literal.offsetSec, 5.5 * 3600);
});

test('stringify round-trips through the parser', () => {
  const text = "local_date(ts) >= DATE '2026-03-01' AND NOT (local_date(ts) < DATE '2026-04-01')";
  const once = stringifyExpression(parseExpression(text));
  const twice = stringifyExpression(parseExpression(once));
  assert.equal(once, twice);
});

test('field and literal types are validated', () => {
  assert.throws(
    () => validateExpression(parseExpression("local_date(ts) = WALL '2026-03-08 00:00:00'")),
    (err) => err instanceof ExprError && /local_date\(ts\) compares against DATE/.test(err.message),
  );
  assert.throws(
    () => validateExpression(parseExpression("ts = DATE '2026-03-08'")),
    (err) => err instanceof ExprError && /ts compares against TS or AT/.test(err.message),
  );
  assert.throws(
    () => validateExpression(parseExpression("local_ts(ts) = TS '2026-03-08T00:00:00Z'")),
    (err) => err instanceof ExprError,
  );
});

test('BETWEEN bounds must be ordered', () => {
  assert.throws(
    () => validateExpression(parseExpression("local_ts(ts) BETWEEN WALL '2026-11-01 02:00:00' AND WALL '2026-11-01 01:00:00'")),
    (err) => err instanceof ExprError && /lower bound is greater/.test(err.message),
  );
});

test('invalid literals are rejected with positions', () => {
  for (const text of [
    "local_date(ts) = DATE '2026-02-30'",
    "local_date(ts) = DATE '2026-13-01'",
    "local_ts(ts) = WALL '2026-01-01 24:00:00'",
    "ts = TS '2026-01-01T00:00:00+25:00'",
  ]) {
    assert.throws(() => parseExpression(text), ExprError, text);
  }
});

test('tokenizer reports the offending position', () => {
  try {
    parseExpression("local_date(ts) = DATE '2026-03-08' ;");
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ExprError);
    assert.equal(typeof err.position, 'number');
    assert.ok(err.position >= 30);
  }
});

test('unterminated string is an error', () => {
  assert.throws(() => parseExpression("local_date(ts) = DATE '2026-03-08"), ExprError);
});

test('leap-year day counts', () => {
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(1900, 2), 28);
  assert.equal(daysInMonth(2026, 4), 30);
});
