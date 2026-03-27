# zodal-store-supabase

zodal DataProvider adapter for **Supabase** (PostgreSQL via PostgREST).

This is the **most capable adapter** in the zodal ecosystem -- it supports full server-side sort, filter, search, and pagination, all delegated to Supabase's PostgREST layer.

## Install

```bash
npm install zodal-store-supabase @supabase/supabase-js @zodal/core @zodal/store
```

## Quick Start

```typescript
import { createClient } from '@supabase/supabase-js';
import { createSupabaseProvider } from 'zodal-store-supabase';

const supabase = createClient('https://your-project.supabase.co', 'your-anon-key');

const provider = createSupabaseProvider({
  client: supabase,
  table: 'projects',
  searchColumns: ['name', 'description'],
});

// List with server-side filtering, sorting, and pagination
const { data, total } = await provider.getList({
  filter: { field: 'status', operator: 'eq', value: 'active' },
  sort: [{ id: 'created_at', desc: true }],
  pagination: { page: 1, pageSize: 25 },
  search: 'dashboard',
});

// CRUD
const created = await provider.create({ name: 'New Project', status: 'active' });
const updated = await provider.update(created.id, { status: 'archived' });
await provider.delete(created.id);
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `SupabaseClient` | **required** | Supabase client instance |
| `table` | `string` | **required** | Database table name |
| `idField` | `string` | `'id'` | Primary key column name |
| `searchColumns` | `string[]` | `[]` | Columns to search with `ilike` |
| `select` | `string` | `'*'` | Column selection string |

## Capabilities

| Capability | Supported |
|------------|-----------|
| Server-side sort | Yes |
| Server-side filter | Yes |
| Server-side search | Yes (when `searchColumns` configured) |
| Server-side pagination | Yes (offset-based) |
| Create / Update / Delete | Yes |
| Bulk update / Bulk delete | Yes |
| Upsert | Yes |

### Supported Filter Operators

`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`, `endsWith`, `in`, `notIn`, `arrayContains`, `arrayContainsAny`, `isNull`, `isNotNull`

Compound filters (`and`, `or`, `not`) are supported. `and` chains sequentially; `or` uses PostgREST's `.or()` syntax; `not` negates leaf conditions.

## How It Works

- **Filtering**: `FilterExpression` trees are translated to PostgREST query builder calls (`.eq()`, `.gte()`, `.ilike()`, etc.)
- **Search**: Builds an OR clause across `searchColumns` using `ilike`
- **Sorting**: Maps to `.order()` calls
- **Pagination**: Uses `.range(start, end)` with 1-based page numbers
- **Total count**: Uses `.select('*', { count: 'exact' })` for accurate totals

## License

MIT
