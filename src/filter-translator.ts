/**
 * Translate zodal FilterExpression to Supabase PostgREST query builder calls.
 */

import type { FilterExpression, FilterCondition } from '@zodal/core';

/**
 * Apply a FilterExpression to a Supabase query builder.
 * Returns the modified query.
 */
export function applyFilter<Q extends Record<string, any>>(
  query: Q,
  filter: FilterExpression,
): Q {
  // Compound: AND — apply each filter sequentially (Supabase chains are AND by default)
  if ('and' in filter) {
    let q = query;
    for (const sub of filter.and) {
      q = applyFilter(q, sub);
    }
    return q;
  }

  // Compound: OR — use Supabase's .or() with comma-separated conditions
  if ('or' in filter) {
    const conditions = filter.or.map(sub => toOrConditionString(sub));
    return (query as any).or(conditions.join(','));
  }

  // Compound: NOT — apply inner filter then negate (limited support)
  if ('not' in filter) {
    const inner = filter.not as FilterCondition;
    if ('field' in inner) {
      return applyNegatedCondition(query, inner);
    }
    // Complex NOT with compound expressions — fall through to client-side
    return query;
  }

  // Leaf: FilterCondition
  return applyCondition(query, filter as FilterCondition);
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
    case 'in': return q.in(field, value as any[]);
    case 'notIn': return q.not(field, 'in', `(${(value as any[]).join(',')})`);
    case 'arrayContains': return q.contains(field, [value]);
    case 'arrayContainsAny': return q.overlaps(field, value as any[]);
    case 'isNull': return q.is(field, null);
    case 'isNotNull': return q.not(field, 'is', null);
    default: return query;
  }
}

function applyNegatedCondition<Q extends Record<string, any>>(
  query: Q,
  condition: FilterCondition,
): Q {
  const { field, operator, value } = condition;
  const q = query as any;

  // Negate by using the opposite operator where possible
  switch (operator) {
    case 'eq': return q.neq(field, value);
    case 'ne': return q.eq(field, value);
    case 'gt': return q.lte(field, value);
    case 'gte': return q.lt(field, value);
    case 'lt': return q.gte(field, value);
    case 'lte': return q.gt(field, value);
    default: return query;
  }
}

function toOrConditionString(filter: FilterExpression): string {
  if ('field' in filter) {
    const { field, operator, value } = filter as FilterCondition;
    const op = operatorToPostgREST(operator);
    return `${field}.${op}.${value}`;
  }
  // Nested compound in OR — limited support
  return '';
}

function operatorToPostgREST(operator: string): string {
  const map: Record<string, string> = {
    eq: 'eq',
    ne: 'neq',
    gt: 'gt',
    gte: 'gte',
    lt: 'lt',
    lte: 'lte',
    contains: 'ilike.*value*',
    in: 'in',
    isNull: 'is.null',
    isNotNull: 'not.is.null',
  };
  return map[operator] ?? 'eq';
}
