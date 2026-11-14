/**
 * Provider descriptors for this package: each Supabase provider described as data,
 * so an app, a playground or an agent can list it in a backend menu, render its
 * options, and create it by name with `createFromDescriptor` from
 * `@zodal/store/descriptor`.
 *
 * - `descriptor` (`supabase`): rows of a table, queried server-side through
 *   PostgREST (`createSupabaseProvider`).
 * - `supabaseBifurcatedDescriptor` (`supabaseBifurcated`): table metadata plus
 *   Supabase Storage content (`createSupabaseBifurcatedProvider`). Not named
 *   `bifurcatedDescriptor`: that is the generic composite in `@zodal/store`.
 * - `storageBlobDescriptor` (`supabaseStorageBlob`): content only, in a Storage
 *   bucket (`createSupabaseStorageBlobProvider`), the content side of a bifurcation.
 *
 * **The client is live.** Every factory takes a configured `SupabaseClient` (which
 * holds the project URL and the key) and none builds its own, so `client` is a
 * `z.custom()` option supplied in code: it is never shown, shared or exported, and
 * there is no credential among the data options.
 *
 * Capabilities depend on the options: search is server-side only when
 * `searchColumns` is given. `create` imports its provider module lazily.
 */

import { z } from 'zod';
import { defineProviderDescriptor } from '@zodal/store/descriptor';
import type { SupabaseClient } from '@supabase/supabase-js';
import { tableCapabilities } from './capabilities.js';

const MODULE = '@zodal/store-supabase';

type Probe = { from?: unknown; storage?: { from?: unknown } } | null | undefined;
const queriesTables = (v: unknown): boolean => typeof (v as Probe)?.from === 'function';
const hasStorage = (v: unknown): boolean => typeof (v as Probe)?.storage?.from === 'function';
const clientDescription = 'A configured SupabaseClient (project URL, key); supply in code.';

const tableClient = z.custom<SupabaseClient>(queriesTables).meta({ description: clientDescription });
const storageClient = z.custom<SupabaseClient>(hasStorage).meta({ description: clientDescription });
const fullClient = z.custom<SupabaseClient>((v) => queriesTables(v) && hasStorage(v)).meta({ description: clientDescription });

const table = z.string().min(1).meta({ description: 'Table (or view) name.' });
const idField = z.string().min(1).optional().meta({ description: "Primary-key column. Default: 'id'." });
const searchColumns = z.array(z.string()).optional().meta({ description: 'Columns searched with ilike. Default: none (search disabled).' });
const select = z.string().min(1).optional().meta({ description: "PostgREST select expression. Default: '*'." });
const contentFields = z.array(z.string()).meta({ description: 'Fields stored as objects in Supabase Storage.' });

/** Rows of a table, queried server-side through PostgREST (`createSupabaseProvider`). */
export const descriptor = defineProviderDescriptor({
  name: 'supabase',
  label: 'Supabase (Postgres table)',
  description: 'Items as rows of a Supabase table; sort, filter, search and pagination run in Postgres.',
  source: { module: MODULE, export: 'descriptor' },
  runtime: 'any',
  options: z.object({ client: tableClient, table, idField, searchColumns, select }),
  capabilities: (o) => tableCapabilities(o.searchColumns),
  create: async (o) => (await import('./provider.js')).createSupabaseProvider(o),
});

/**
 * Table metadata plus Storage content (`createSupabaseBifurcatedProvider`).
 * Already metadata + content in one provider, so it is marked `composite` and is
 * not offered as a child of `bifurcatedDescriptor`.
 */
export const supabaseBifurcatedDescriptor = defineProviderDescriptor({
  name: 'supabaseBifurcated',
  label: 'Supabase (table + Storage)',
  description: 'Queryable fields as rows of a table, content fields as objects in a Storage bucket.',
  source: { module: MODULE, export: 'supabaseBifurcatedDescriptor' },
  runtime: 'any',
  composite: true,
  options: z.object({
    client: fullClient,
    table,
    storageBucket: z.string().min(1).meta({ description: 'Storage bucket for content.' }),
    storagePrefix: z.string().optional().meta({ description: "Storage path prefix. Default: ''." }),
    contentFields,
    idField,
    searchColumns,
    select,
    includePublicUrl: z.boolean().optional().meta({ description: 'Put public URLs in content references. Default: true.' }),
  }),
  capabilities: (o) => ({
    ...tableCapabilities(o.searchColumns),
    canUpsert: false, // this provider has no upsert
    bifurcated: true,
    contentFields: o.contentFields,
  }),
  create: async (o) => (await import('./storage-provider.js')).createSupabaseBifurcatedProvider(o),
});

/** Content only, as `{prefix}{id}/{field}` Storage objects (`createSupabaseStorageBlobProvider`). */
export const storageBlobDescriptor = defineProviderDescriptor({
  name: 'supabaseStorageBlob',
  label: 'Supabase Storage (content)',
  description: 'Content fields only, as objects in a Supabase Storage bucket; pair it with a metadata provider.',
  source: { module: MODULE, export: 'storageBlobDescriptor' },
  runtime: 'any',
  options: z.object({
    client: storageClient,
    bucket: z.string().min(1).meta({ description: 'Storage bucket name.' }),
    prefix: z.string().optional().meta({ description: "Storage path prefix. Default: ''." }),
    contentFields,
    idField,
  }),
  capabilities: {
    canCreate: true, canUpdate: true, canDelete: true,
    canBulkUpdate: true, canBulkDelete: true, canUpsert: false,
    serverSort: false, serverFilter: false, serverSearch: false, serverPagination: false,
  },
  create: async (o) => (await import('./blob-provider.js')).createSupabaseStorageBlobProvider(o),
});
