/**
 * `applyFilter` / `toLogicTree`: the exact PostgREST calls (via a recording
 * builder), what they select (via the in-memory mock), and the errors for what
 * cannot be expressed.
 */

import { describe, it, expect } from 'vitest';
import type { FilterExpression } from '@zodal/core';
import { applyFilter, toLogicTree, UnsupportedFilterError } from '../src/filter-translator.js';
import { searchClause } from '../src/filter-translator.js';
import { createMockSupabaseClient } from './mock-supabase.js';

/** A builder that records each call as `[method, ...args]`. */
function recorder() {
  const calls: unknown[][] = [];
  const q: any = new Proxy({}, {
    get: (_t, method: string) => (...args: unknown[]) => {
      calls.push([method, ...args]);
      return q;
    },
  });
  return { q, calls };
}

const calls = (filter: FilterExpression) => {
  const r = recorder();
  applyFilter(r.q, filter);
  return r.calls;
};

const rows = [
  { id: '1', name: 'Alpha, Inc. (v1)', status: 'active', priority: 3, tags: ['web', 'frontend'] },
  { id: '2', name: 'Beta API', status: 'draft', priority: 1, tags: ['api'] },
  { id: '3', name: 'Gamma Platform', status: 'archived', priority: 5, tags: ['web', 'api'] },
  { id: '4', name: 'Delta', status: 'active', priority: 2, tags: [] },
];

async function select(filter: FilterExpression): Promise<string[]> {
  const client = createMockSupabaseClient({ t: rows });
  const { data, error } = await applyFilter(client.from('t').select('*'), filter);
  if (error) throw new Error(error.message);
  return data.map((r: any) => r.id).sort();
}

const eq = (field: string, value: unknown): FilterExpression => ({ field, operator: 'eq', value });
const gte = (field: string, value: unknown): FilterExpression => ({ field, operator: 'gte', value });

describe('not over a compound', () => {
  it('sends not.or(...) as a one-member .or()', () => {
    expect(calls({ not: { or: [eq('status', 'active'), gte('priority', 5)] } })).toEqual([
      ['or', 'not.or(status.eq."active",priority.gte.5)'],
    ]);
  });

  it('sends not.and(...) as a one-member .or()', () => {
    expect(calls({ not: { and: [eq('status', 'active'), gte('priority', 3)] } })).toEqual([
      ['or', 'not.and(status.eq."active",priority.gte.3)'],
    ]);
  });

  it('selects the complement of the compound', async () => {
    expect(await select({ not: { or: [eq('status', 'active'), gte('priority', 5)] } })).toEqual(['2']);
    expect(await select({ not: { and: [eq('status', 'active'), gte('priority', 3)] } })).toEqual(['2', '3', '4']);
  });

  it('a double negation cancels', async () => {
    expect(toLogicTree({ not: { not: eq('status', 'draft') } })).toBe('status.eq."draft"');
    expect(await select({ not: { not: { or: [eq('status', 'draft')] } } })).toEqual(['2']);
  });
});

describe('not over a condition', () => {
  it('uses the opposite comparison where there is one', () => {
    expect(calls({ not: gte('priority', 3) })).toEqual([['lt', 'priority', 3]]);
  });

  it('uses field.not.op.value for the other operators (it used to drop them)', async () => {
    const f: FilterExpression = { not: { field: 'tags', operator: 'arrayContains', value: 'web' } };
    expect(calls(f)).toEqual([['or', 'tags.not.cs.{"web"}']]);
    expect(await select(f)).toEqual(['2', '4']);
  });

  it('negating notIn and isNotNull gives in and is.null, not a double not', () => {
    expect(toLogicTree({ not: { field: 'status', operator: 'notIn', value: ['draft'] } })).toBe('status.in.("draft")');
    expect(toLogicTree({ not: { field: 'status', operator: 'isNotNull', value: null } })).toBe('status.is.null');
  });
});

describe('or', () => {
  it('nests a compound member as and(...) (it used to produce an empty member)', async () => {
    const f: FilterExpression = {
      or: [eq('status', 'draft'), { and: [eq('status', 'active'), gte('priority', 3)] }],
    };
    expect(calls(f)).toEqual([['or', 'status.eq."draft",and(status.eq."active",priority.gte.3)']]);
    expect(await select(f)).toEqual(['1', '2']);
  });

  it('writes contains as ilike with * wildcards (it used to emit "ilike.*value*.<value>")', async () => {
    const f: FilterExpression = { or: [{ field: 'name', operator: 'contains', value: 'platform' }, eq('id', '2')] };
    expect(calls(f)).toEqual([['or', 'name.ilike."*platform*",id.eq."2"']]);
    expect(await select(f)).toEqual(['2', '3']);
  });

  it('quotes values holding reserved characters', async () => {
    const f: FilterExpression = { or: [eq('name', 'Alpha, Inc. (v1)'), eq('name', 'say "hi"\\')] };
    expect(calls(f)).toEqual([['or', 'name.eq."Alpha, Inc. (v1)",name.eq."say \\"hi\\"\\\\"']]);
    expect(await select(f)).toEqual(['1']);
  });

  it('translates every operator inside a tree', async () => {
    const f: FilterExpression = {
      or: [
        { field: 'status', operator: 'in', value: ['draft', 'x,y'] },
        { field: 'tags', operator: 'arrayContainsAny', value: ['frontend'] },
        { field: 'name', operator: 'startsWith', value: 'Gam' },
      ],
    };
    expect(calls(f)).toEqual([['or', 'status.in.("draft","x,y"),tags.ov.{"frontend"},name.ilike."Gam*"']]);
    expect(await select(f)).toEqual(['1', '2', '3']);
  });

  it('search quotes the term, so a comma cannot split the clause', () => {
    expect(searchClause(['name', 'status'], 'a,b')).toBe('name.ilike."*a,b*",status.ilike."*a,b*"');
  });
});

describe('what cannot be expressed throws instead of being dropped', () => {
  it('an unknown operator', () => {
    expect(() => calls({ field: 'x', operator: 'regex' as any, value: '.' })).toThrow(UnsupportedFilterError);
    expect(() => calls({ or: [{ field: 'x', operator: 'regex' as any, value: '.' }] })).toThrow(UnsupportedFilterError);
  });

  it('an empty or, at the top or nested', () => {
    expect(() => calls({ or: [] })).toThrow(UnsupportedFilterError);
    expect(() => calls({ not: { and: [] } })).toThrow(UnsupportedFilterError);
  });

  it('a null or object value inside a tree', () => {
    expect(() => calls({ or: [eq('status', null)] })).toThrow(/isNull/);
    expect(() => calls({ or: [eq('status', { a: 1 })] })).toThrow(UnsupportedFilterError);
  });

  it('a brace inside an array element inside a tree', () => {
    expect(() => calls({ or: [{ field: 'tags', operator: 'arrayContains', value: 'a}b' }] })).toThrow(UnsupportedFilterError);
  });
});
