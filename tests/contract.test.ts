/**
 * The DataProvider contract from `@zodal/store/testing`, run against the table
 * provider and the bifurcated provider over the in-memory PostgREST mock
 * (`./mock-supabase.ts`), which evaluates the filters, sorts and ranges the
 * providers send. Each case gets a fresh client seeded with the contract rows.
 *
 * No case is skipped: `not` over a compound is sent as a PostgREST logic tree
 * (`or=(not.or(...))`), so it is supported.
 */

import { describe, it } from 'vitest';
import { providerContract, type ContractRow } from '@zodal/store/testing';
import type { DataProvider } from '@zodal/store';
import { createSupabaseProvider } from '../src/provider.js';
import { createSupabaseBifurcatedProvider } from '../src/storage-provider.js';
import { createMockSupabaseClient } from './mock-supabase.js';

const table = 'items';

const shapes: [string, (seed: ContractRow[]) => DataProvider<ContractRow>][] = [
  [
    'table provider',
    (seed) =>
      createSupabaseProvider<ContractRow>({
        client: createMockSupabaseClient({ [table]: seed }) as any,
        table,
        searchColumns: ['name'],
      }),
  ],
  [
    'bifurcated provider (no content fields)',
    (seed) =>
      createSupabaseBifurcatedProvider<ContractRow>({
        client: createMockSupabaseClient({ [table]: seed }) as any,
        table,
        storageBucket: 'content',
        contentFields: [],
        searchColumns: ['name'],
      }),
  ],
];

for (const [label, make] of shapes) {
  const cases = await providerContract({ make });
  describe(`supabase ${label}: DataProvider contract`, () => {
    for (const c of cases) (c.skip ? it.skip : it)(c.name, c.run);
  });
}
