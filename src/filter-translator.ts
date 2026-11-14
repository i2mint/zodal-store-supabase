/**
 * Translate a zodal `FilterExpression` into Supabase PostgREST query builder calls.
 *
 * - A top-level `and` chains its members (PostgREST ANDs every filter).
 * - A leaf condition becomes the matching builder method (`.eq`, `.ilike`, `.contains`...).
 * - An `or`, and any negation without a direct builder method, become a PostgREST
 *   *logic tree* passed to `.or()`: `field.op.value`, `field.not.op.value`,
 *   `and(...)`, `or(...)`, `not.and(...)`, `not.or(...)`. A top-level `not` over a
 *   compound is sent as a one-member tree, e.g. `.or('not.or(a.eq.1,b.gte.5)')`
 *   (query string `or=(not.or(a.eq.1,b.gte.5))`).
 *
 * String values in a logic tree are always double-quoted (with `\` escapes), so a
 * value holding PostgREST's reserved characters (`,` `.` `:` `(` `)`) cannot break
 * the clause.
 *
 * Anything that cannot be expressed throws {@link UnsupportedFilterError}. A
 * dropped filter returns more rows than asked for, silently, which is worse than
 * an error.
 */

import type { FilterExpression, FilterCondition } from '@zodal/core';

/** Thrown when a `FilterExpression` cannot be expressed as a PostgREST filter. */
export class UnsupportedFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFilterError';
  }
}

const isAnd = (f: FilterExpression): f is { and: FilterExpression[] } => 'and' in f;
const isOr = (f: FilterExpression): f is { or: FilterExpression[] } => 'or' in f;
const isNot = (f: FilterExpression): f is { not: FilterExpression } => 'not' in f;

/**
 * Apply a FilterExpression to a Supabase query builder.
 * Returns the modified query. Throws {@link UnsupportedFilterError} for a filter
 * it cannot express.
 */
export function applyFilter<Q extends Record<string, any>>(
  query: Q,
  filter: FilterExpression,
): Q {
  if (isAnd(filter)) {
    let q = query;
    for (const sub of filter.and) q = applyFilter(q, sub);
    return q;
  }

  if (isOr(filter)) {
    if (filter.or.length === 0) throw new UnsupportedFilterError('an empty "or" cannot be expressed in PostgREST');
    return (query as any).or(filter.or.map((sub) => toLogicTree(sub)).join(','));
  }

  if (isNot(filter)) {
    const inner = filter.not;
    if (!isAnd(inner) && !isOr(inner) && !isNot(inner)) {
      const opposite = negatedComparison(query, inner as FilterCondition);
      if (opposite) return opposite;
    }
    // Negated compound (or a negated condition with no opposite operator):
    // a one-member logic tree, `not.and(...)`, `not.or(...)` or `field.not.op.value`.
    return (query as any).or(toLogicTree(filter));
  }

  return applyCondition(query, filter as FilterCondition);
}

/**
 * The `.or()` clause for a case-insensitive substring search across `columns`.
 */
export function searchClause(columns: readonly string[], search: string): string {
  return columns
    .map((field) => conditionToTree({ field, operator: 'contains', value: search }, false))
    .join(',');
}

function applyCondition<Q extends Record<string, any>>(
  query: Q,
  condition: FilterCondition,
): Q {
  const { field, operator, value } = condition;
  const q = query as any;

  switch (operator) {
    case 'eq': return q.eq(field, value);
    case 'ne': return q.neq(field, value);
    case 'gt': return q.gt(field, value);
    case 'gte': return q.gte(field, value);
    case 'lt': return q.lt(field, value);
    case 'lte': return q.lte(field, value);
    case 'contains': return q.ilike(field, `%${value}%`);
    case 'startsWith': return q.ilike(field, `${value}%`);
    case 'endsWith': return q.ilike(field, `%${value}`);
    case 'in': return q.in(field, asArray(value, condition));
    case 'notIn': return q.not(field, 'in', listValue(asArray(value, condition)));
    case 'arrayContains': return q.contains(field, [value]);
    case 'arrayContainsAny': return q.overlaps(field, asArray(value, condition));
    case 'isNull': return q.is(field, null);
    case 'isNotNull': return q.not(field, 'is', null);
    default:
      throw new UnsupportedFilterError(`unknown filter operator "${String(operator)}" on field "${field}"`);
  }
}

/** `not` over a comparison, as the opposite comparison (same SQL NULL semantics). */
function negatedComparison<Q extends Record<string, any>>(
  query: Q,
  condition: FilterCondition,
): Q | undefined {
  const { field, operator, value } = condition;
  const q = query as any;
  switch (operator) {
    case 'eq': return q.neq(field, value);
    case 'ne': return q.eq(field, value);
    case 'gt': return q.lte(field, value);
    case 'gte': return q.lt(field, value);
    case 'lt': return q.gte(field, value);
    case 'lte': return q.gt(field, value);
    default: return undefined;
  }
}

// ---- logic trees ------------------------------------------------------------

/** A FilterExpression as one member of a PostgREST logic tree. */
export function toLogicTree(filter: FilterExpression, negate = false): string {
  if (isNot(filter)) return toLogicTree(filter.not, !negate);
  if (isAnd(filter) || isOr(filter)) {
    const [name, members] = isAnd(filter) ? ['and', filter.and] : ['or', filter.or];
    if (members.length === 0) {
      throw new UnsupportedFilterError(`an empty "${name}" cannot be expressed in a PostgREST logic tree`);
    }
    return `${negate ? 'not.' : ''}${name}(${members.map((m) => toLogicTree(m)).join(',')})`;
  }
  return conditionToTree(filter as FilterCondition, negate);
}

function conditionToTree(condition: FilterCondition, negate: boolean): string {
  const { field, operator, value } = condition;
  let op: string;
  let val: string;
  let negated = false;
  switch (operator) {
    case 'eq': op = 'eq'; val = scalar(value, condition); break;
    case 'ne': op = 'neq'; val = scalar(value, condition); break;
    case 'gt': op = 'gt'; val = scalar(value, condition); break;
    case 'gte': op = 'gte'; val = scalar(value, condition); break;
    case 'lt': op = 'lt'; val = scalar(value, condition); break;
    case 'lte': op = 'lte'; val = scalar(value, condition); break;
    // `*` is PostgREST's URL-safe alias for the LIKE wildcard `%`.
    case 'contains': op = 'ilike'; val = quote(`*${text(value, condition)}*`); break;
    case 'startsWith': op = 'ilike'; val = quote(`${text(value, condition)}*`); break;
    case 'endsWith': op = 'ilike'; val = quote(`*${text(value, condition)}`); break;
    case 'in': op = 'in'; val = listValue(asArray(value, condition)); break;
    case 'notIn': op = 'in'; val = listValue(asArray(value, condition)); negated = true; break;
    case 'arrayContains': op = 'cs'; val = pgArray([value], condition); break;
    case 'arrayContainsAny': op = 'ov'; val = pgArray(asArray(value, condition), condition); break;
    case 'isNull': op = 'is'; val = 'null'; break;
    case 'isNotNull': op = 'is'; val = 'null'; negated = true; break;
    default:
      throw new UnsupportedFilterError(`unknown filter operator "${String(operator)}" on field "${field}"`);
  }
  return `${field}.${negated !== negate ? 'not.' : ''}${op}.${val}`;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function text(value: unknown, condition: FilterCondition): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  throw new UnsupportedFilterError(
    `"${condition.operator}" on "${condition.field}" needs a string value, got ${JSON.stringify(value)}`,
  );
}

function scalar(value: unknown, condition: FilterCondition): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return quote(value);
  if (value instanceof Date) return quote(value.toISOString());
  throw new UnsupportedFilterError(
    `"${condition.operator}" on "${condition.field}" inside or/not needs a string, number, boolean or Date, ` +
      `got ${JSON.stringify(value)}${value == null ? ' (use isNull / isNotNull)' : ''}`,
  );
}

function asArray(value: unknown, condition: FilterCondition): unknown[] {
  if (Array.isArray(value)) return value;
  throw new UnsupportedFilterError(
    `"${condition.operator}" on "${condition.field}" needs an array value, got ${JSON.stringify(value)}`,
  );
}

/** A PostgREST list, `("a","b",3)`. */
function listValue(values: unknown[]): string {
  return `(${values.map((v) => (typeof v === 'string' ? quote(v) : String(v))).join(',')})`;
}

/** A PostgreSQL array literal, `{"a","b"}` (PostgREST reads it up to the closing brace). */
function pgArray(values: unknown[], condition: FilterCondition): string {
  const parts = values.map((v) => {
    const s = String(v);
    if (/[{}]/.test(s)) {
      throw new UnsupportedFilterError(
        `"${condition.operator}" on "${condition.field}" inside or/not cannot hold "{" or "}" (${JSON.stringify(v)})`,
      );
    }
    return typeof v === 'number' ? s : quote(s);
  });
  return `{${parts.join(',')}}`;
}
