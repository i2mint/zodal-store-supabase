export { createSupabaseProvider } from './provider.js';
export type { SupabaseProviderOptions } from './provider.js';
export { applyFilter, toLogicTree, UnsupportedFilterError } from './filter-translator.js';

// Supabase bifurcated: PostgreSQL metadata + Supabase Storage content
export { createSupabaseBifurcatedProvider } from './storage-provider.js';
export type { SupabaseBifurcatedOptions } from './storage-provider.js';

// Blob-only provider for cross-backend bifurcation
export { createSupabaseStorageBlobProvider } from './blob-provider.js';
export type { SupabaseStorageBlobOptions } from './blob-provider.js';

// Provider descriptors (a backend menu: list, configure, create by name)
export { descriptor, supabaseBifurcatedDescriptor, storageBlobDescriptor } from './descriptor.js';
