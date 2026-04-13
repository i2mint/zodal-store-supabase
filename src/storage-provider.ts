/**
 * Supabase Bifurcated Provider: PostgreSQL metadata + Supabase Storage content.
 *
 * Uses the same Supabase client for both:
 *   - Metadata: PostgreSQL table (full server-side sort/filter/search/pagination)
 *   - Content: Supabase Storage bucket (S3-compatible object storage)
 *
 * Content objects are stored at: {bucket}/{prefix}{id}/{field}
 * Metadata table stores reference columns: {field}_url, {field}_size, {field}_mime
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DataProvider, GetListParams, GetListResult } from '@zodal/store';
import type { ProviderCapabilities } from '@zodal/store';
import { createSupabaseProvider } from './provider.js';

/** Content reference — matches @zodal/core ContentRef (available in >= 0.2.0). */
export interface ContentRef {
  readonly _tag: 'ContentRef';
  field: string;
  itemId: string;
  hash?: string;
  url?: string;
  mimeType?: string;
  size?: number;
}

export interface SupabaseBifurcatedOptions {
  /** Supabase client instance. */
  client: SupabaseClient;
  /** Database table name for metadata. */
  table: string;
  /** Supabase Storage bucket name for content. */
  storageBucket: string;
  /** Storage path prefix. Default: ''. */
  storagePrefix?: string;
  /** Content field names. */
  contentFields: string[];
  /** ID field. Default: 'id'. */
  idField?: string;
  /** Columns for text search. Default: none. */
  searchColumns?: string[];
  /** Select expression for metadata columns. Default: '*'. */
  select?: string;
  /** Whether to include public URLs in ContentRef. Default: true. */
  includePublicUrl?: boolean;
}

/**
 * Create a bifurcated Supabase provider using PostgreSQL for metadata
 * and Supabase Storage for content.
 *
 * This is a convenience factory that wires up the most common Supabase
 * bifurcation pattern. For custom setups, use createBifurcatedProvider()
 * from @zodal/store directly.
 *
 * @example
 * ```typescript
 * const provider = createSupabaseBifurcatedProvider({
 *   client: supabase,
 *   table: 'documents',
 *   storageBucket: 'doc-content',
 *   contentFields: ['attachment'],
 * });
 * ```
 */
export function createSupabaseBifurcatedProvider<T extends Record<string, any>>(
  options: SupabaseBifurcatedOptions,
): DataProvider<T> {
  const {
    client, table, storageBucket, contentFields,
    includePublicUrl = true,
  } = options;
  const storagePrefix = options.storagePrefix ?? '';
  const idField = options.idField ?? 'id';
  const contentSet = new Set(contentFields);

  // Metadata provider: standard Supabase table provider
  const metaProvider = createSupabaseProvider<Record<string, any>>({
    client,
    table,
    idField,
    searchColumns: options.searchColumns,
    select: options.select,
  });

  // --- Storage helpers ---

  function storagePath(id: string, field: string): string {
    return `${storagePrefix}${id}/${field}`;
  }

  function toContentRef(id: string, field: string, meta?: Record<string, any>): ContentRef {
    const ref: ContentRef = { _tag: 'ContentRef', field, itemId: id };

    if (meta) {
      if (meta[`${field}_mime`]) ref.mimeType = meta[`${field}_mime`];
      if (meta[`${field}_size`]) ref.size = meta[`${field}_size`];
      if (meta[`${field}_url`]) ref.url = meta[`${field}_url`];
    }

    // Generate public URL if requested and not already set
    if (includePublicUrl && !ref.url) {
      const { data } = client.storage.from(storageBucket).getPublicUrl(storagePath(id, field));
      if (data?.publicUrl) ref.url = data.publicUrl;
    }

    return ref;
  }

  async function uploadContent(id: string, field: string, content: unknown): Promise<{ size?: number; mime?: string }> {
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

    const path = storagePath(id, field);
    const { error } = await client.storage.from(storageBucket).upload(path, body, {
      contentType,
      upsert: true,
    });

    if (error) throw new Error(`Storage upload failed for ${field}: ${error.message}`);

    return {
      size: typeof body === 'string' ? body.length : (body as Blob).size,
      mime: contentType,
    };
  }

  async function downloadContent(id: string, field: string): Promise<Blob> {
    const { data, error } = await client.storage
      .from(storageBucket)
      .download(storagePath(id, field));

    if (error) throw new Error(`Storage download failed for ${field}: ${error.message}`);
    return data;
  }

  async function deleteContent(id: string): Promise<void> {
    const paths = contentFields.map(f => storagePath(id, f));
    await client.storage.from(storageBucket).remove(paths);
  }

  // --- Field splitting ---

  function splitData(data: Record<string, any>): { meta: Record<string, any>; content: Record<string, any> } {
    const meta: Record<string, any> = {};
    const content: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (contentSet.has(key)) {
        content[key] = value;
      } else {
        meta[key] = value;
      }
    }
    return { meta, content };
  }

  function addContentRefs(item: Record<string, any>): Record<string, any> {
    const result = { ...item };
    for (const field of contentFields) {
      result[field] = toContentRef(String(item[idField]), field, item);
    }
    return result;
  }

  // --- Provider ---

  return {
    async getList(params: GetListParams): Promise<GetListResult<T>> {
      const result = await metaProvider.getList(params);
      return {
        data: result.data.map(addContentRefs) as T[],
        total: result.total,
      };
    },

    async getOne(id: string): Promise<T> {
      const meta = await metaProvider.getOne(id);
      return addContentRefs(meta) as T;
    },

    async create(data: Partial<T>): Promise<T> {
      const id = String((data as any)[idField] ?? crypto.randomUUID());
      const { meta, content } = splitData({ ...data, [idField]: id } as Record<string, any>);

      // Upload content first (to get size/mime for metadata)
      const refMeta: Record<string, any> = {};
      for (const [field, value] of Object.entries(content)) {
        const info = await uploadContent(id, field, value);
        if (info.mime) refMeta[`${field}_mime`] = info.mime;
        if (info.size) refMeta[`${field}_size`] = info.size;
        const { data: urlData } = client.storage.from(storageBucket).getPublicUrl(storagePath(id, field));
        if (urlData?.publicUrl) refMeta[`${field}_url`] = urlData.publicUrl;
      }

      // Create metadata with content reference columns
      const created = await metaProvider.create({ ...meta, ...refMeta });
      return addContentRefs(created) as T;
    },

    async update(id: string, data: Partial<T>): Promise<T> {
      const { meta, content } = splitData(data as Record<string, any>);

      // Upload new content
      const refMeta: Record<string, any> = {};
      for (const [field, value] of Object.entries(content)) {
        const info = await uploadContent(id, field, value);
        if (info.mime) refMeta[`${field}_mime`] = info.mime;
        if (info.size) refMeta[`${field}_size`] = info.size;
      }

      // Update metadata (including ref columns)
      const metaUpdate = { ...meta, ...refMeta };
      const updated = Object.keys(metaUpdate).length > 0
        ? await metaProvider.update(id, metaUpdate)
        : await metaProvider.getOne(id);

      return addContentRefs(updated) as T;
    },

    async updateMany(ids: string[], data: Partial<T>): Promise<T[]> {
      return Promise.all(ids.map(id => this.update(id, data)));
    },

    async delete(id: string): Promise<void> {
      await deleteContent(id);
      await metaProvider.delete(id);
    },

    async deleteMany(ids: string[]): Promise<void> {
      await Promise.all(ids.map(id => this.delete(id)));
    },

    getCapabilities(): ProviderCapabilities {
      const metaCaps = metaProvider.getCapabilities!();
      return {
        ...metaCaps,
        ...({ bifurcated: true, contentFields } as any),
      };
    },

    async getContent(id: string, field: string): Promise<Blob> {
      if (!contentSet.has(field)) throw new Error(`'${field}' is not a content field`);
      return downloadContent(id, field);
    },

    async setContent(id: string, field: string, content: unknown): Promise<ContentRef> {
      if (!contentSet.has(field)) throw new Error(`'${field}' is not a content field`);
      await uploadContent(id, field, content);
      return toContentRef(id, field);
    },
  } as DataProvider<T>;
}
