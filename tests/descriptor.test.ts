/**
 * The provider descriptors: created by name through `createFromDescriptor` over the
 * in-memory PostgREST mock, the table and bifurcated providers pass the
 * `@zodal/store/testing` contract; the client is live (a real client's key never
 * appears in redacted or shared options); bad options fail with a structural
 * error naming the descriptor; and the menu's capabilities, which depend on
 * `searchColumns`, are what the provider reports.
 */

import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  createFromDescriptor,
  defineProviderDescriptor,
  describedCapabilities,
  isProviderSupported,
  liveOptionPaths,
  redactOptions,
  secretOptionPaths,
  splitOptions,
  bifurcatedDescriptor,
  LIVE,
  type ProviderDescriptor,
} from '@zodal/store/descriptor';
import { providerContract, type ContractRow } from '@zodal/store/testing';
import type { DataProvider } from '@zodal/store';
import { descriptor, supabaseBifurcatedDescriptor, storageBlobDescriptor } from '../src/index.js';
import { createMockSupabaseClient } from './mock-supabase.js';

const paths = (ps: readonly (readonly (string | number)[])[]) => ps.map((p) => p.join('.')).sort();
const table = 'items';
const KEY = 'sb-service-role-DO-NOT-SHOW';

// The contract, run through the descriptor path (validation, then lazy create).
const contractShapes: [string, ProviderDescriptor, Record<string, unknown>][] = [
  ['descriptor', descriptor, { table, searchColumns: ['name'] }],
  ['supabaseBifurcatedDescriptor (no content fields)', supabaseBifurcatedDescriptor, { table, storageBucket: 'content', contentFields: [], searchColumns: ['name'] }],
];
for (const [label, d, options] of contractShapes) {
  const cases = await providerContract({
    make: async (seed) =>
      (await createFromDescriptor(d, { ...options, client: createMockSupabaseClient({ [table]: seed }) })) as DataProvider<ContractRow>,
  });
  describe(`supabase ${label} via createFromDescriptor: DataProvider contract`, () => {
    for (const c of cases) (c.skip ? it.skip : it)(c.name, c.run);
  });
}

const all: [string, ProviderDescriptor, Record<string, unknown>][] = [
  ['descriptor', descriptor, { table, idField: 'id', searchColumns: ['name'], select: 'id,name' }],
  ['supabaseBifurcatedDescriptor', supabaseBifurcatedDescriptor, { table, storageBucket: 'docs', storagePrefix: 'p/', contentFields: ['body'], includePublicUrl: false }],
  ['storageBlobDescriptor', storageBlobDescriptor, { bucket: 'docs', prefix: 'p/', contentFields: ['body'] }],
];

describe('supabase provider descriptors', () => {
  it('are accepted by defineProviderDescriptor, with distinct names and their own source', async () => {
    for (const [, d] of all) expect(defineProviderDescriptor(d)).toBe(d);
    expect(all.map(([, d]) => d.name)).toEqual(['supabase', 'supabaseBifurcated', 'supabaseStorageBlob']);
    for (const [exportName, d] of all) {
      expect(d.source).toEqual({ module: '@zodal/store-supabase', export: exportName });
      expect(d.runtime).toBe('any');
      expect(await isProviderSupported(d)).toBe(true);
    }
  });

  it('create a working provider from valid options', async () => {
    const client = createMockSupabaseClient({ [table]: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] });
    const provider = await createFromDescriptor(descriptor, { client, table, searchColumns: ['name'] });
    expect((await provider.getList({ search: 'alp' })).data).toEqual([{ id: 'a', name: 'Alpha' }]);

    const blobs = await createFromDescriptor(storageBlobDescriptor, { client, bucket: 'docs', contentFields: ['body'] });
    await blobs.create({ id: 'n1', body: 'hello' });
    expect(await blobs.getOne('n1')).toMatchObject({ id: 'n1', body: 'hello' });
  });

  it('reject invalid options with a structural error naming the descriptor', async () => {
    const client = createMockSupabaseClient({});
    await expect(createFromDescriptor(descriptor, { table })).rejects.toThrow(/Invalid options for provider "supabase": client: custom/);
    await expect(createFromDescriptor(descriptor, { client: { url: 'https://x' }, table })).rejects.toThrow(/provider "supabase": client: custom/);
    await expect(createFromDescriptor(descriptor, { client })).rejects.toThrow(/provider "supabase": table: invalid_type/);
    await expect(createFromDescriptor(descriptor, { client, table, searchColumns: 'name' })).rejects.toThrow(/searchColumns: invalid_type/);
    // A table-only client cannot back the Storage providers.
    const tableOnly = { from: client.from.bind(client) };
    await expect(createFromDescriptor(supabaseBifurcatedDescriptor, { client: tableOnly, table, storageBucket: 'b', contentFields: [] })).rejects.toThrow(
      /provider "supabaseBifurcated": client: custom/,
    );
    await expect(createFromDescriptor(storageBlobDescriptor, { client, contentFields: [] })).rejects.toThrow(/provider "supabaseStorageBlob": bucket: invalid_type/);
  });

  it('have no secret among the data options, and the client as the only live one', () => {
    for (const [, d] of all) {
      expect(secretOptionPaths(d)).toEqual([]);
      expect(paths(liveOptionPaths(d))).toEqual(['client']);
    }
  });

  it("never show a real client's key in redacted or shared options", () => {
    const client = createClient('https://example.supabase.co', KEY);
    const options = { client, table, searchColumns: ['name'] };
    const redacted = redactOptions(descriptor, options);
    expect(redacted).toEqual({ client: LIVE, table, searchColumns: ['name'] });
    expect(JSON.stringify(redacted)).not.toContain(KEY);
    expect(splitOptions(descriptor, options).data).toEqual({ table, searchColumns: ['name'] });
  });

  it('describe capabilities from the options, as the provider reports them (search needs searchColumns)', async () => {
    for (const [, d, o] of all) {
      const provider = await createFromDescriptor(d, { ...o, client: createMockSupabaseClient({}) });
      expect(describedCapabilities(d, o as any)).toEqual(provider.getCapabilities!());
    }
    expect(describedCapabilities(descriptor, { table } as any).serverSearch).toBe(false);
    expect(describedCapabilities(descriptor, { table, searchColumns: ['name'] } as any).serverSearch).toBe(true);
    expect(describedCapabilities(supabaseBifurcatedDescriptor, { table, storageBucket: 'b', contentFields: ['body'] } as any)).toMatchObject({
      serverFilter: true,
      canUpsert: false,
      bifurcated: true,
      contentFields: ['body'],
    });
  });

  it('compose under bifurcatedDescriptor (table metadata, Storage blobs); the bifurcated provider is not a child', async () => {
    const bifurcated = bifurcatedDescriptor(all.map(([, d]) => d));
    const client = createMockSupabaseClient({ [table]: [] });
    await expect(
      createFromDescriptor(bifurcated, {
        metadata: { name: 'supabaseBifurcated', options: { client, table, storageBucket: 'b', contentFields: [] } },
        content: { name: 'supabaseStorageBlob', options: { client, bucket: 'b', contentFields: ['body'] } },
        contentFields: ['body'],
      }),
    ).rejects.toThrow(/Invalid options for provider "bifurcated"/);

    const provider = await createFromDescriptor(bifurcated, {
      metadata: { name: 'supabase', options: { client, table } },
      content: { name: 'supabaseStorageBlob', options: { client, bucket: 'blobs', contentFields: ['body'] } },
      contentFields: ['body'],
    });
    await provider.create({ id: 'n1', title: 'Note', body: 'hello' });
    expect((await provider.getList({})).data.map((r: any) => r.title)).toEqual(['Note']);
    expect(describedCapabilities(bifurcated)).toMatchObject({ bifurcated: true });
  });
});
