// A small, strict predicate language for zoned date filtering.
//
//   local_date(ts) >= DATE '2026-03-01'
//     AND local_date(ts) < DATE '2026-04-01'
//     AND NOT (local_ts(ts) BETWEEN WALL '2026-03-08 02:00:00' AND WALL '2026-03-08 03:00:00')
//
// Fields:
//   ts                UTC instant (microseconds since epoch)
//   local_date(ts)    local calendar date in the query timezone
//   local_ts(ts)      local wall-clock timestamp (whole seconds) in the query timezone
//
// Literals:
//   DATE 'YYYY-MM-DD'                     date
//   WALL 'YYYY-MM-DD HH:MM:SS'            wall-clock timestamp
//   TS   'YYYY-MM-DDTHH:MM:SSZ'           UTC instant, explicit Z or ±HH:MM offset
//   AT   'YYYY-MM-DD HH:MM:SS'            wall literal resolved to an instant under the ambiguity policy

import { daysFromCivil } from './tz.mjs';

const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'BETWEEN', 'IN']);
const LITERAL_KINDS = new Set(['DATE', 'WALL', 'TS', 'AT']);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

export class ExprError extends Error {
  constructor(message, position = null) {
    super(message);
    this.name = 'ExprError';
    this.position = position;
  }
}

function parseDate(text) {
  const m = DATE_RE.exec(text);
  if (!m) throw new ExprError(`Invalid DATE literal: ${text} (expected YYYY-MM-DD)`);
  const [year, month, day] = [+m[1], +m[2], +m[3]];
  validateCivil(year, month, day, text);
  return { year, month, day };
}

function parseWall(text) {
  const m = WALL_RE.exec(text);
  if (!m) throw new ExprError(`Invalid WALL literal: ${text} (expected YYYY-MM-DD HH:MM:SS)`);
  const [year, month, day, hour, minute, second] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
  validateCivil(year, month, day, text);
  if (hour > 23 || minute > 59 || second > 59) throw new ExprError(`Invalid WALL time: ${text}`);
  return { year, month, day, hour, minute, second };
}

function parseInstant(text) {
  const m = TS_RE.exec(text);
  if (!m) {
    throw new ExprError(`Invalid TS literal: ${text} (expected YYYY-MM-DDTHH:MM:SSZ or ±HH:MM)`);
  }
  const [year, month, day, hour, minute, second] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
  validateCivil(year, month, day, text);
  if (hour > 23 || minute > 59 || second > 59) throw new ExprError(`Invalid TS time: ${text}`);
  const fracUs = m[7] ? Number(m[7].padEnd(6, '0')) : 0;
  let offsetSec = 0;
  if (m[8] !== 'Z') {
    const sign = m[8][0] === '-' ? -1 : 1;
    const hh = Number(m[8].slice(1, 3));
    const mm = Number(m[8].slice(4, 6));
    if (hh > 23 || mm > 59) throw new ExprError(`Invalid TS offset: ${text}`);
    offsetSec = sign * (hh * 3600 + mm * 60);
  }
  return { year, month, day, hour, minute, second, fracUs, offsetSec };
}

function validateCivil(year, month, day, text) {
  if (year < 1900 || year > 2100) throw new ExprError(`Year out of supported range (1900-2100): ${text}`);
  if (month < 1 || month > 12) throw new ExprError(`Invalid month: ${text}`);
  const days = daysInMonth(year, month);
  if (day < 1 || day > days) throw new ExprError(`Invalid day: ${text}`);
}

export function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ kind: ch, value: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === '<' || ch === '>' || ch === '=' || ch === '!') {
      const two = input.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '<>' || two === '!=') {
        tokens.push({ kind: 'op', value: two === '<>' ? '!=' : two, pos: i });
        i += 2;
      } else if (ch === '=') {
        tokens.push({ kind: 'op', value: '=', pos: i });
        i += 1;
      } else if (ch === '<' || ch === '>') {
        tokens.push({ kind: 'op', value: ch, pos: i });
        i += 1;
      } else {
        throw new ExprError(`Unexpected character '${ch}'`, i);
      }
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let value = '';
      while (j < input.length) {
        if (input[j] === "'") {
          if (input[j + 1] === "'") { value += "'"; j += 2; continue; }
          break;
        }
        value += input[j];
        j += 1;
      }
      if (j >= input.length) throw new ExprError('Unterminated string literal', i);
      tokens.push({ kind: 'string', value, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      const raw = input.slice(i, j);
      const upper = raw.toUpperCase();
      tokens.push({ kind: KEYWORDS.has(upper) ? 'kw' : 'ident', value: KEYWORDS.has(upper) ? upper : raw, pos: i });
      i = j;
      continue;
    }
    throw new ExprError(`Unexpected character '${ch}'`, i);
  }
  tokens.push({ kind: 'eof', value: '<end>', pos: input.length });
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek(offset = 0) { return this.tokens[this.index + offset]; }
  next() { return this.tokens[this.index++]; }

  expect(kind, value = null) {
    const tok = this.peek();
    if (tok.kind !== kind || (value !== null && tok.value !== value)) {
      throw new ExprError(`Expected ${value ?? kind}, found ${tok.value}`, tok.pos);
    }
    return this.next();
  }

  match(kind, value = null) {
    const tok = this.peek();
    if (tok.kind === kind && (value === null || tok.value === value)) return this.next();
    return null;
  }

  parse() {
    if (this.peek().kind === 'eof') throw new ExprError('Expression is empty');
    const node = this.parseOr();
    if (this.peek().kind !== 'eof') {
      throw new ExprError(`Unexpected token ${this.peek().value}`, this.peek().pos);
    }
    return node;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.match('kw', 'OR')) {
      const right = this.parseAnd();
      left = { type: 'or', left, right };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.match('kw', 'AND')) {
      const right = this.parseNot();
      left = { type: 'and', left, right };
    }
    return left;
  }

  parseNot() {
    if (this.match('kw', 'NOT')) {
      return { type: 'not', operand: this.parseNot() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    if (this.match('(', '(')) {
      const node = this.parseOr();
      this.expect(')', ')');
      return node;
    }
    return this.parseComparison();
  }

  parseField() {
    const tok = this.peek();
    if (tok.kind !== 'ident') throw new ExprError(`Expected a field, found ${tok.value}`, tok.pos);
    const name = this.next().value.toLowerCase();
    if (name === 'ts') return { name: 'ts' };
    if (name === 'local_date' || name === 'local_ts') {
      this.expect('(', '(');
      const arg = this.expect('ident');
      if (arg.value.toLowerCase() !== 'ts') {
        throw new ExprError(`${name}() takes ts as its only argument`, arg.pos);
      }
      this.expect(')', ')');
      return { name };
    }
    throw new ExprError(`Unknown field '${name}'`, tok.pos);
  }

  parseLiteral() {
    const tok = this.peek();
    if (tok.kind === 'string') {
      throw new ExprError('String literals need a type keyword: DATE, WALL, TS or AT', tok.pos);
    }
    if (tok.kind !== 'ident' && tok.kind !== 'kw') {
      throw new ExprError(`Expected a literal, found ${tok.value}`, tok.pos);
    }
    const kind = this.next().value.toUpperCase();
    if (!LITERAL_KINDS.has(kind)) {
      throw new ExprError(`Expected DATE, WALL, TS or AT, found ${tok.value}`, tok.pos);
    }
    const str = this.expect('string');
    if (kind === 'DATE') return { type: 'date', ...parseDate(str.value), text: str.value };
    if (kind === 'WALL') return { type: 'wall', ...parseWall(str.value), text: str.value };
    if (kind === 'TS') return { type: 'instant', ...parseInstant(str.value), text: str.value };
    return { type: 'at', ...parseWall(str.value), text: str.value };
  }

  parseComparison() {
    const field = this.parseField();
    const negated = this.match('kw', 'NOT') !== null;
    if (this.match('kw', 'BETWEEN')) {
      const lo = this.parseLiteral();
      this.expect('kw', 'AND');
      const hi = this.parseLiteral();
      return { type: 'between', field, lo, hi, negated };
    }
    if (this.match('kw', 'IN')) {
      this.expect('(', '(');
      const values = [this.parseLiteral()];
      while (this.match(',', ',')) values.push(this.parseLiteral());
      this.expect(')', ')');
      return { type: 'in', field, values, negated };
    }
    if (negated) throw new ExprError('NOT is only supported before BETWEEN or IN here', this.peek().pos);
    const opTok = this.peek();
    if (opTok.kind !== 'op') throw new ExprError(`Expected a comparison operator, found ${opTok.value}`, opTok.pos);
    const op = this.next().value;
    const literal = this.parseLiteral();
    return { type: 'compare', field, op, literal };
  }
}

export function parseExpression(text) {
  const tokens = tokenize(text);
  return new Parser(tokens).parse();
}

/** Validate field/literal type compatibility; throws ExprError. */
export function validateExpression(node, supportsAt = true) {
  switch (node.type) {
    case 'and':
    case 'or':
      validateExpression(node.left, supportsAt);
      validateExpression(node.right, supportsAt);
      return;
    case 'not':
      validateExpression(node.operand, supportsAt);
      return;
    case 'compare':
    case 'between':
    case 'in': {
      const field = node.field.name;
      const literals = node.type === 'compare' ? [node.literal]
        : node.type === 'between' ? [node.lo, node.hi]
          : node.values;
      for (const lit of literals) {
        if (field === 'local_date' && lit.type !== 'date') {
          throw new ExprError(`local_date(ts) compares against DATE literals, found ${literalLabel(lit)}`);
        }
        if (field === 'local_ts' && lit.type !== 'wall' && lit.type !== 'at') {
          throw new ExprError(`local_ts(ts) compares against WALL literals, found ${literalLabel(lit)}`);
        }
        if (field === 'ts' && lit.type === 'date') {
          throw new ExprError('ts compares against TS or AT literals, found DATE');
        }
        if (field === 'ts' && lit.type === 'wall') {
          throw new ExprError('ts compares against TS or AT literals, found WALL (use AT to resolve a wall time)');
        }
        if (field === 'ts' && lit.type === 'at' && !supportsAt) {
          throw new ExprError('AT literals are not allowed in this context');
        }
      }
      if (node.type === 'between') {
        if (compareLiteralOrder(node.field.name, node.lo, node.hi) > 0) {
          throw new ExprError('BETWEEN lower bound is greater than upper bound');
        }
      }
      return;
    }
    default:
      throw new ExprError(`Unknown node type ${node.type}`);
  }
}

export function literalLabel(lit) {
  const kind = lit.type === 'date' ? 'DATE' : lit.type === 'wall' ? 'WALL' : lit.type === 'at' ? 'AT' : 'TS';
  return `${kind} '${lit.text}'`;
}

/** Compare two literals on the same semantic scale. */
export function compareLiteralOrder(field, a, b) {
  const av = literalScalar(field, a);
  const bv = literalScalar(field, b);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

export function literalScalar(field, lit) {
  if (field === 'local_date') return daysFromCivil(lit.year, lit.month, lit.day);
  const day = daysFromCivil(lit.year, lit.month, lit.day);
  if (field === 'local_ts') return day * 86400 + lit.hour * 3600 + lit.minute * 60 + lit.second;
  // ts field: instant literal (µs)
  if (lit.type === 'instant') {
    return daysFromCivil(lit.year, lit.month, lit.day) * 86_400_000_000
      + lit.hour * 3_600_000_000 + lit.minute * 60_000_000 + lit.second * 1_000_000
      + lit.fracUs - lit.offsetSec * 1_000_000;
  }
  // AT literals are resolved later; compare wall values here.
  return day * 86400 + lit.hour * 3600 + lit.minute * 60 + lit.second;
}

/** Serialize an AST back to canonical text. */
export function stringifyExpression(node, depth = 0) {
  const wrap = (child, needed) => {
    const text = stringifyExpression(child, depth + 1);
    return needed ? `(${text})` : text;
  };
  switch (node.type) {
    case 'and':
      return `${wrap(node.left, node.left.type === 'or')} AND ${wrap(node.right, node.right.type === 'or')}`;
    case 'or':
      return `${wrap(node.left, node.left.type === 'or')} OR ${wrap(node.right, node.right.type === 'or')}`;
    case 'not': {
      const text = stringifyExpression(node.operand, depth + 1);
      return `NOT (${text})`;
    }
    case 'compare':
      return `${fieldLabel(node.field)} ${node.op} ${literalLabel(node.literal)}`;
    case 'between':
      return `${fieldLabel(node.field)} ${node.negated ? 'NOT ' : ''}BETWEEN ${literalLabel(node.lo)} AND ${literalLabel(node.hi)}`;
    case 'in':
      return `${fieldLabel(node.field)} ${node.negated ? 'NOT ' : ''}IN (${node.values.map(literalLabel).join(', ')})`;
    default:
      throw new Error(`Unknown node ${node.type}`);
  }
}

export function fieldLabel(field) {
  return field.name === 'ts' ? 'ts' : `${field.name}(ts)`;
}
