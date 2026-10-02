import { openDB, type IDBPDatabase } from 'idb';

/**
 * Local, server-free store for favourited GIFs.
 *
 * Everything lives in IndexedDB, per browser profile and per instance origin —
 * nothing is sent to a server, so favourites survive reloads and work offline
 * (for uploaded files) but do not sync across devices.
 *
 * A favourite is one of two kinds:
 *   - `url`  — a provider GIF (Tenor/Klipy) or any GIF link. Identified by the
 *              exact trimmed URL.
 *   - `file` — a GIF uploaded as an attachment. Identified by the SHA-256 of its
 *              bytes, so the same file uploaded twice (even by different people,
 *              under different attachment URLs) is one entry. The bytes are kept
 *              so the favourite can be re-uploaded later.
 */

const DB_NAME = 'artium-gifs';
const STORE = 'favorites';
const VERSION = 1;

export interface GifFavorite {
  /** `url:<normalized url>` or `file:<sha256>`. */
  id: string;
  kind: 'url' | 'file';
  /** kind === 'url' */
  url?: string;
  previewUrl?: string;
  /** kind === 'file' */
  blob?: Blob;
  mimeType?: string;
  width?: number;
  height?: number;
  /** Ordering key: newest first. */
  addedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('addedAt', 'addedAt');
        }
      },
    });
  }
  return dbPromise;
}

/** All favourites, newest first. */
export async function listFavorites(): Promise<GifFavorite[]> {
  const db = await getDB();
  const ascending = await db.getAllFromIndex(STORE, 'addedAt');
  return ascending.reverse();
}

export async function putFavorite(favorite: GifFavorite): Promise<void> {
  const db = await getDB();
  await db.put(STORE, favorite);
}

export async function deleteFavorite(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE, id);
}

/** Wipe the store. Used by tests and on logout. */
export async function clearFavorites(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE);
}

/** Exact, trimmed URL. Kept strict so one link always maps to one entry. */
export function normalizeGifUrl(url: string): string {
  return url.trim();
}

export function urlFavoriteId(url: string): string {
  return `url:${normalizeGifUrl(url)}`;
}

export function fileFavoriteId(hash: string): string {
  return `file:${hash}`;
}

/** Lowercase hex SHA-256 of a blob's bytes — the identity of an uploaded GIF. */
export async function hashBlob(blob: Blob): Promise<string> {
  // Wrap in a Uint8Array so the buffer is accepted even when the Blob came from
  // another realm (jsdom tests); a plain ArrayBuffer would be rejected there.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
