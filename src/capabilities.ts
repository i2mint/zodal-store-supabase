/**
 * What `createSupabaseProvider` does server-side: everything PostgREST can, with
 * search only when there are columns to search.
 *
 * A module of its own so the provider descriptors can describe capabilities
 * without importing the providers.
 */

import type { ProviderCapabilities } from '@zodal/store';

/** The table provider's capabilities, given its `searchColumns`. */
export function tableCapabilities(searchColumns: readonly string[] = []): ProviderCapabilities {
  return {
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    canBulkUpdate: true,
    canBulkDelete: true,
    canUpsert: true,
    serverSort: true,
    serverFilter: true,
    serverSearch: searchColumns.length > 0,
    serverPagination: true,
    paginationStyle: 'offset',
    filterOperators: {
      '*': [
        'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
        'contains', 'startsWith', 'endsWith',
        'in', 'notIn',
        'arrayContains', 'arrayContainsAny',
        'isNull', 'isNotNull',
      ],
    },
  };
}
