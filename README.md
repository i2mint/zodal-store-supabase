# zodal-store-supabase

zodal DataProvider adapter for **Supabase** (PostgreSQL via PostgREST).

This is the **most capable adapter** in the zodal ecosystem -- it supports full server-side sort, filter, search, and pagination, all delegated to Supabase's PostgREST layer.

## Install

```bash
npm install @zodal/store-supabase @supabase/supabase-js @zodal/core @zodal/store zod
```

## Quick Start

```typescript
import { createClient } from '@supabase/supabase-js';
import { createSupabaseProvider } from '@zodal/store-supabase';

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

Compound filters (`and`, `or`, `not`) are supported, nested to any depth. `and` chains sequentially; `or` and `not` become a PostgREST logic tree passed to `.or()` (`not` over a compound is sent as `or=(not.or(...))` / `or=(not.and(...))`). A filter that cannot be expressed (an unknown operator, an empty `or`, a `null` value inside `or`/`not`) throws `UnsupportedFilterError` instead of being dropped.

`delete` of a missing id rejects with `Item not found`; `updateMany` / `deleteMany` skip missing ids.

## Use from a menu

Each provider is also exported as a descriptor (`@zodal/store` ≥ 0.2.2): name, runtime, options as a Zod schema and capabilities, so an app, a playground or an agent can list it and create it by name.

```typescript
import { createClient } from '@supabase/supabase-js';
import { createFromDescriptor, describedCapabilities, splitOptions } from '@zodal/store/descriptor';
import { descriptor, supabaseBifurcatedDescriptor, storageBlobDescriptor } from '@zodal/store-supabase';
// 'supabase', 'supabaseBifurcated', 'supabaseStorageBlob'

const options = { client: createClient(url, anonKey), table: 'projects', searchColumns: ['name'] };
describedCapabilities(descriptor, options).serverSearch; // true: search needs searchColumns
const provider = await createFromDescriptor(descriptor, options);
splitOptions(descriptor, options).data; // { table: 'projects', searchColumns: ['name'] }: the client is left out
```

`client` (which holds the project URL and key) is a live option: supplied in code, never shown, shared or exported, so no credential appears among the data options. `supabaseBifurcatedDescriptor` is marked `composite`; for a cross-backend split, give `storageBlobDescriptor` to `bifurcatedDescriptor` from `@zodal/store/descriptor`.

## How It Works

- **Filtering**: `FilterExpression` trees are translated to PostgREST query builder calls (`.eq()`, `.gte()`, `.ilike()`, etc.)
- **Search**: Builds an OR clause across `searchColumns` using `ilike`
- **Sorting**: Maps to `.order()` calls
- **Pagination**: Uses `.range(start, end)` with 1-based page numbers
- **Total count**: Uses `.select('*', { count: 'exact' })` for accurate totals

## License

MIT
