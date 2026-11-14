import { describe, it, expect, beforeEach } from 'vitest';
import { createSupabaseProvider } from '../src/index.js';
import { createMockSupabaseClient } from './mock-supabase.js';

interface TestItem {
  id: string;
  name: string;
  priority: number;
}

describe('createSupabaseProvider', () => {
  let mockClient: ReturnType<typeof createMockSupabaseClient>;
  let provider: ReturnType<typeof createSupabaseProvider<TestItem>>;

  beforeEach(() => {
    mockClient = createMockSupabaseClient();
    provider = createSupabaseProvider<TestItem>({
      client: mockClient as any,
      table: 'test_items',
      searchColumns: ['name'],
    });
  });

  it('creates and retrieves an item', async () => {
    const created = await provider.create({ id: '1', name: 'Alpha', priority: 1 });
    expect(created.name).toBe('Alpha');
    const fetched = await provider.getOne('1');
    expect(fetched.name).toBe('Alpha');
  });

  it('lists items', async () => {
    await provider.create({ id: '1', name: 'A', priority: 1 });
    await provider.create({ id: '2', name: 'B', priority: 2 });
    const { data, total } = await provider.getList({});
    expect(data).toHaveLength(2);
    expect(total).toBe(2);
  });

  it('updates an item', async () => {
    await provider.create({ id: '1', name: 'Before', priority: 1 });
    const updated = await provider.update('1', { name: 'After' });
    expect(updated.name).toBe('After');
  });

  it('deletes an item', async () => {
    await provider.create({ id: '1', name: 'Doomed', priority: 1 });
    await provider.delete('1');
    await expect(provider.getOne('1')).rejects.toThrow('Item not found');
  });

  it('upserts — insert when new', async () => {
    await provider.upsert!({ id: '1', name: 'V1', priority: 1 });
    const fetched = await provider.getOne('1');
    expect(fetched.name).toBe('V1');
  });

  it('upserts — update when existing', async () => {
    await provider.upsert!({ id: '1', name: 'V1', priority: 1 });
    await provider.upsert!({ id: '1', name: 'V2', priority: 2 });
    const fetched = await provider.getOne('1');
    expect(fetched.name).toBe('V2');
  });

  it('sorts results ascending', async () => {
    await provider.create({ id: '1', name: 'Zebra', priority: 3 });
    await provider.create({ id: '2', name: 'Alpha', priority: 1 });
    await provider.create({ id: '3', name: 'Middle', priority: 2 });
    const { data } = await provider.getList({
      sort: [{ id: 'name', desc: false }],
    });
    expect(data[0]!.name).toBe('Alpha');
    expect(data[2]!.name).toBe('Zebra');
  });

  it('sorts results descending', async () => {
    await provider.create({ id: '1', name: 'A', priority: 1 });
    await provider.create({ id: '2', name: 'B', priority: 2 });
    const { data } = await provider.getList({
      sort: [{ id: 'priority', desc: true }],
    });
    expect(data[0]!.priority).toBe(2);
    expect(data[1]!.priority).toBe(1);
  });

  it('paginates results', async () => {
    for (let i = 0; i < 15; i++) {
      await provider.create({ id: String(i), name: `Item ${i}`, priority: i });
    }
    const { data, total } = await provider.getList({
      pagination: { page: 2, pageSize: 5 },
    });
    expect(data).toHaveLength(5);
    expect(total).toBe(15);
  });

  it('filters with eq operator', async () => {
    await provider.create({ id: '1', name: 'Alpha', priority: 1 });
    await provider.create({ id: '2', name: 'Beta', priority: 2 });
    const { data } = await provider.getList({
      filter: { field: 'priority', operator: 'eq', value: 2 },
    });
    expect(data).toHaveLength(1);
    expect(data[0]!.name).toBe('Beta');
  });

  it('filters with gte operator', async () => {
    await provider.create({ id: '1', name: 'Low', priority: 1 });
    await provider.create({ id: '2', name: 'Mid', priority: 5 });
    await provider.create({ id: '3', name: 'High', priority: 10 });
    const { data } = await provider.getList({
      filter: { field: 'priority', operator: 'gte', value: 5 },
    });
    expect(data).toHaveLength(2);
  });

  it('deletes many items', async () => {
    await provider.create({ id: '1', name: 'A', priority: 1 });
    await provider.create({ id: '2', name: 'B', priority: 2 });
    await provider.create({ id: '3', name: 'C', priority: 3 });
    await provider.deleteMany(['1', '3']);
    const { data, total } = await provider.getList({});
    expect(total).toBe(1);
    expect(data[0]!.name).toBe('B');
  });

  it('updates many items', async () => {
    await provider.create({ id: '1', name: 'A', priority: 1 });
    await provider.create({ id: '2', name: 'B', priority: 2 });
    await provider.create({ id: '3', name: 'C', priority: 3 });
    const updated = await provider.updateMany(['1', '2'], { priority: 99 });
    expect(updated).toHaveLength(2);
    expect(updated[0]!.priority).toBe(99);
  });

  it('reports server-side capabilities', () => {
    const caps = provider.getCapabilities!();
    expect(caps.serverSort).toBe(true);
    expect(caps.serverFilter).toBe(true);
    expect(caps.serverPagination).toBe(true);
    expect(caps.serverSearch).toBe(true);
    expect(caps.canCreate).toBe(true);
    expect(caps.canUpdate).toBe(true);
    expect(caps.canDelete).toBe(true);
    expect(caps.canBulkUpdate).toBe(true);
    expect(caps.canBulkDelete).toBe(true);
    expect(caps.canUpsert).toBe(true);
    expect(caps.paginationStyle).toBe('offset');
  });

  it('reports no search when no searchColumns configured', () => {
    const noSearchProvider = createSupabaseProvider<TestItem>({
      client: mockClient as any,
      table: 'test',
    });
    const caps = noSearchProvider.getCapabilities!();
    expect(caps.serverSearch).toBe(false);
  });
});
