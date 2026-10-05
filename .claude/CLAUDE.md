# zodal-store-supabase -- Agent Guide

## What This Is

A zodal `DataProvider<T>` adapter for Supabase (PostgreSQL via PostgREST). The most capable adapter in the zodal ecosystem, supporting full server-side sort, filter, search, and pagination.

## Package Structure

```
src/
  index.ts              # Re-exports
  provider.ts           # createSupabaseProvider factory
  filter-translator.ts  # FilterExpression -> PostgREST query builder calls / logic trees
  storage-provider.ts   # createSupabaseBifurcatedProvider (table metadata + Storage content)
  blob-provider.ts      # createSupabaseStorageBlobProvider
  capabilities.ts       # tableCapabilities(searchColumns): shared by the providers and the descriptors
  descriptor.ts         # provider descriptors: descriptor (supabase), supabaseBifurcatedDescriptor, storageBlobDescriptor
tests/
  mock-supabase.ts           # In-memory PostgREST evaluator (filters, or/not trees, order, range, count)
  provider.test.ts           # Unit tests over the mock
  filter-translator.test.ts  # Exact PostgREST calls + what they select + what throws
  contract.test.ts           # @zodal/store/testing conformance kit (table + bifurcated provider)
  descriptor.test.ts         # the kit through createFromDescriptor; live client, validation, capabilities
```

## Key Design Decisions

- **Factory function pattern**: `createSupabaseProvider(options)` returns a `DataProvider<T>` object (not a class).
- **Filter translation**: `applyFilter()` translates zodal `FilterExpression` to Supabase's chainable query builder methods; `or` and `not` (including `not` over a compound) become a PostgREST logic tree via `.or()`. Untranslatable filters throw `UnsupportedFilterError`, never drop silently.
- **Contract**: `delete` of a missing id rejects (it asks for the deleted rows back: PostgREST resolves a zero-row delete). The bifurcated provider declares `canUpsert: false` (it has no `upsert`) and skips missing ids in `updateMany`/`deleteMany`.
- **Client-side fallback**: none. Everything is server-side, so `applyQuery` from `@zodal/store` is not used.
- **Search**: OR clause across configurable `searchColumns` using `ilike`.
- **Pagination**: Offset-based via `.range(start, end)` with 1-based page numbers.
- **Capabilities**: Honestly reported via `getCapabilities()` -- all server-side features enabled (`tableCapabilities()` in `src/capabilities.ts`; search only with `searchColumns`).
- **Descriptors** (`src/descriptor.ts`, built with `defineProviderDescriptor` from `@zodal/store/descriptor`): `client` is a `z.custom()` (live, never shared) checked for `.from` / `.storage.from`; no factory builds its own client, so there is no credential among the data options. Capabilities are a function of the options. Keep each options schema in step with its factory's options (validation strips undeclared keys). The bifurcated one is `supabaseBifurcatedDescriptor` (`bifurcatedDescriptor` is the generic composite in `@zodal/store`).

## Dependencies

- `@zodal/core` -- types (`FilterExpression`, `FilterCondition`, `SortingState`)
- `@zodal/store` -- interface (`DataProvider`, `GetListParams`, `GetListResult`, `ProviderCapabilities`)
- `@supabase/supabase-js` -- Supabase client (peer dependency)
- `zod` (peer) -- the descriptors' options schemas

## Testing

Tests use `tests/mock-supabase.ts`, an in-memory client that evaluates the PostgREST builder calls (with SQL NULL logic and the `.or()` logic-tree syntax), so the conformance kit in `tests/contract.test.ts` runs against real filter semantics. Extend the mock when the provider starts calling a new builder method. Run with `pnpm test` or `npx vitest run`.

## Related

- zodal monorepo: https://github.com/i2mint/zodal
- Store adapter skill: https://github.com/i2mint/zodal/tree/main/.claude/skills/zodal-store-adapter
- Reference in-memory provider: https://github.com/i2mint/zodal/tree/main/packages/store/src/in-memory.ts
