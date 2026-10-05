/**
 * Supabase DataProvider for zodal.
 *
 * Leverages PostgREST for server-side sort, filter, search, and pagination.
 * The most capable adapter in the zodal ecosystem.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DataProvider, GetListParams, GetListResult, ProviderCapabilities } from '@zodal/store';
import { applyFilter, searchClause } from './filter-translator.js';
import { tableCapabilities } from './capabilities.js';

export interface SupabaseProviderOptions {
  /** Supabase client instance. */
  client: SupabaseClient;
  /** Database table name. */
  table: string;
  /** Field name used as the unique identifier. Default: 'id'. */
  idField?: string;
  /** Columns to search with ilike when `search` is provided. Default: none (search disabled). */
  searchColumns?: string[];
  /** Select specific columns. Default: '*'. */
  select?: string;
}

export function createSupabaseProvider<T extends Record<string, any>>(
  options: SupabaseProviderOptions,
): DataProvider<T> {
  const { client, table, select = '*' } = options;
  const idField = options.idField ?? 'id';
  const searchColumns = options.searchColumns ?? [];

  return {
    async getList(params: GetListParams): Promise<GetListResult<T>> {
      let query = client.from(table).select(select, { count: 'exact' });

      // Apply filters
      if (params.filter) {
        query = applyFilter(query, params.filter) as typeof query;
      }

      // Apply search (OR across searchColumns using ilike)
      if (params.search && searchColumns.length > 0) {
        query = query.or(searchClause(searchColumns, params.search));
      }

      // Apply sorting
      if (params.sort && params.sort.length > 0) {
        for (const s of params.sort) {
          query = query.order(s.id, { ascending: !s.desc });
        }
      }

      // Apply pagination
      if (params.pagination) {
        const { page, pageSize } = params.pagination;
        const start = (page - 1) * pageSize;
        const end = start + pageSize - 1;
        query = query.range(start, end);
      }

      const { data, count, error } = await query;

      if (error) throw new Error(`Supabase error: ${error.message}`);

      return {
        data: (data ?? []) as unknown as T[],
        total: count ?? 0,
      };
    },

    async getOne(id: string): Promise<T> {
      const { data, error } = await client
        .from(table)
        .select(select)
        .eq(idField, id)
        .single();

      if (error) {
        if (error.code === 'PGRST116') throw new Error(`Item not found: ${id}`);
        throw new Error(`Supabase error: ${error.message}`);
      }

      return data as unknown as T;
    },

    async create(data: Partial<T>): Promise<T> {
      const { data: created, error } = await client
        .from(table)
        .insert(data)
        .select(select)
        .single();

      if (error) throw new Error(`Supabase error: ${error.message}`);
      return created as unknown as T;
    },

    async update(id: string, data: Partial<T>): Promise<T> {
      const { data: updated, error } = await client
        .from(table)
        .update(data)
        .eq(idField, id)
        .select(select)
        .single();

      if (error) {
        if (error.code === 'PGRST116') throw new Error(`Item not found: ${id}`);
        throw new Error(`Supabase error: ${error.message}`);
      }

      return updated as unknown as T;
    },

    async updateMany(ids: string[], data: Partial<T>): Promise<T[]> {
      const { data: updated, error } = await client
        .from(table)
        .update(data)
        .in(idField, ids)
        .select(select);

      if (error) throw new Error(`Supabase error: ${error.message}`);
      return (updated ?? []) as unknown as T[];
    },

    async delete(id: string): Promise<void> {
      // PostgREST resolves a delete that matched no row, so ask for the deleted
      // rows back and reject when there are none (the DataProvider contract).
      const { data, error } = await client
        .from(table)
        .delete()
        .eq(idField, id)
        .select(idField);

      if (error) throw new Error(`Supabase error: ${error.message}`);
      if (!data || data.length === 0) throw new Error(`Item not found: ${id}`);
    },

    async deleteMany(ids: string[]): Promise<void> {
      const { error } = await client
        .from(table)
        .delete()
        .in(idField, ids);

      if (error) throw new Error(`Supabase error: ${error.message}`);
    },

    async upsert(data: T): Promise<T> {
      const { data: result, error } = await client
        .from(table)
        .upsert(data)
        .select(select)
        .single();

      if (error) throw new Error(`Supabase error: ${error.message}`);
      return result as unknown as T;
    },

    getCapabilities(): ProviderCapabilities {
      return tableCapabilities(searchColumns);
    },
  };
}
