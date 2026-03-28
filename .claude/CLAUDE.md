# zodal-store-supabase -- Agent Guide

## What This Is

A zodal `DataProvider<T>` adapter for Supabase (PostgreSQL via PostgREST). The most capable adapter in the zodal ecosystem, supporting full server-side sort, filter, search, and pagination.

## Package Structure

```
src/
  index.ts              # Re-exports
  provider.ts           # createSupabaseProvider factory
  filter-translator.ts  # FilterExpression -> PostgREST query builder calls
tests/
  provider.test.ts      # Unit tests with mock Supabase client
```

## Key Design Decisions

- **Factory function pattern**: `createSupabaseProvider(options)` returns a `DataProvider<T>` object (not a class).
- **Filter translation**: `applyFilter()` recursively translates zodal `FilterExpression` to Supabase's chainable query builder methods.
- **Search**: OR clause across configurable `searchColumns` using `ilike`.
- **Pagination**: Offset-based via `.range(start, end)` with 1-based page numbers.
- **Capabilities**: Honestly reported via `getCapabilities()` -- all server-side features enabled.

## Dependencies

- `@zodal/core` -- types (`FilterExpression`, `FilterCondition`, `SortingState`)
- `@zodal/store` -- interface (`DataProvider`, `GetListParams`, `GetListResult`, `ProviderCapabilities`)
- `@supabase/supabase-js` -- Supabase client (peer dependency)

## Testing

Tests use a mock Supabase client that simulates the chainable query builder pattern in-memory. Run with `pnpm test` or `npx vitest run`.

## Related

- zodal monorepo: https://github.com/i2mint/zodal
- Store adapter skill: https://github.com/i2mint/zodal/tree/main/.claude/skills/zodal-store-adapter
- Reference in-memory provider: https://github.com/i2mint/zodal/tree/main/packages/store/src/in-memory.ts
