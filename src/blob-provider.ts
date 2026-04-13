/**
 * Supabase Storage Blob Provider: Pure content-only storage for cross-backend bifurcation.
 *
 * Stores each content field as a Supabase Storage object at:
 *   {bucket}/{prefix}{id}/{field}
 *
 * Designed to be used as the `contentProvider` argument to
 * `createBifurcatedProvider()` from @zodal/store, paired with any
 * metadata provider (Supabase PostgreSQL, in-memory, etc.).
 *
 * @example
 * ```typescript
 * import { createBifurcatedProvider } from '@zodal/store';
 * import { createSupabaseProvider, createSupabaseStorageBlobProvider } from '@zodal/store-supabase';
 *
 * const provider = createBifurcatedProvider({
 *   metadataProvider: createSupabaseProvider({ client: supabase, table: 'docs' }),
 *   contentProvider: createSupabaseStorageBlobProvider({
 *     client: supabase,
 *     bucket: 'doc-content',
 *     contentFields: ['attachment'],
 *   }),
 *   contentFields: ['attachment'],
 * });
 * ```
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DataProvider, GetListParams, GetListResult } from '@zodal/store';
import type { ProviderCapabilities } from '@zodal/store';

export interface SupabaseStorageBlobOptions {
  /** Supabase client instance. */
  client: SupabaseClient;
  /** Supabase Storage bucket name. */
  bucket: string;
  /** Storage path prefix. Default: ''. */
  prefix?: string;
  /** Content field names this provider manages. */
  contentFields: string[];
  /** Field used as unique identifier. Default: 'id'. */
  idField?: string;
}

export function createSupabaseStorageBlobProvider<T extends Record<string, any>>(
  options: SupabaseStorageBlobOptions,
): DataProvider<T> {
  const { client, bucket, contentFields } = options;
  const prefix = options.prefix ?? '';
  const idField = options.idField ?? 'id';
  const contentSet = new Set(contentFields);

  function blobPath(id: string, field: string): string {
    return `${prefix}${id}/${field}`;
  }

  async function putBlob(id: string, field: string, content: unknown): Promise<void> {
    let body: Blob | string;
    let contentType = 'application/octet-stream';

    if (content instanceof Blob) {
      body = content;
      contentType = content.type || contentType;
    } else if (typeof content === 'string') {
      body = content;
      contentType = 'text/plain';
    } else if (content instanceof Uint8Array || content instanceof ArrayBuffer) {
      body = new Blob([content as BlobPart]);
    } else {
      body = JSON.stringify(content);
      contentType = 'application/json';
    }

    const { error } = await client.storage.from(bucket).upload(
      blobPath(id, field),
      body,
      { contentType, upsert: true },
    );

    if (error) throw new Error(`Storage upload failed for ${field}: ${error.message}`);
  }

  async function getBlob(id: string, field: string): Promise<Blob> {
    const { data, error } = await client.storage
      .from(bucket)
      .download(blobPath(id, field));

    if (error) throw new Error(`Storage download failed for ${field}: ${error.message}`);
    return data;
  }

  async function deleteBlobs(id: string): Promise<void> {
    const paths = contentFields.map(f => blobPath(id, f));
    await client.storage.from(bucket).remove(paths);
  }

  return {
    async getList(): Promise<GetListResult<T>> {
      // Content-only provider — metadata provider handles listing
      return { data: [], total: 0 };
    },

    async getOne(id: string): Promise<T> {
      const result: Record<string, any> = { [idField]: id };
      for (const field of contentFields) {
        try {
          result[field] = await getBlob(id, field);
        } catch {
          // Field may not have been stored yet
        }
      }
      return result as T;
    },

    async create(data: Partial<T>): Promise<T> {
      const id = String((data as any)[idField]);
      for (const [key, value] of Object.entries(data as Record<string, any>)) {
        if (contentSet.has(key) && value !== undefined) {
          await putBlob(id, key, value);
        }
      }
      return { [idField]: id } as T;
    },

    async update(id: string, data: Partial<T>): Promise<T> {
      for (const [key, value] of Object.entries(data as Record<string, any>)) {
        if (contentSet.has(key) && value !== undefined) {
          await putBlob(id, key, value);
        }
      }
      return { [idField]: id } as T;
    },

    async updateMany(ids: string[], data: Partial<T>): Promise<T[]> {
      return Promise.all(ids.map(id => this.update(id, data)));
    },

    async delete(id: string): Promise<void> {
      await deleteBlobs(id);
    },

    async deleteMany(ids: string[]): Promise<void> {
      await Promise.all(ids.map(id => this.delete(id)));
    },

    getCapabilities(): ProviderCapabilities {
      return {
        canCreate: true,
        canUpdate: true,
        canDelete: true,
        canBulkUpdate: true,
        canBulkDelete: true,
        canUpsert: false,
        serverSort: false,
        serverFilter: false,
        serverSearch: false,
        serverPagination: false,
      };
    },
  };
}
