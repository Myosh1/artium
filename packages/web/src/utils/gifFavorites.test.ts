import { describe, it, expect, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import 'fake-indexeddb/auto';

// jsdom ships `crypto` without SubtleCrypto; back it with Node's so `hashBlob`
// can be exercised. The data is re-wrapped in a Node-realm Uint8Array because
// jsdom's ArrayBuffer comes from a different realm and Node's digest rejects it.
if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    value: {
      digest: (algorithm: AlgorithmIdentifier, data: BufferSource) =>
        webcrypto.subtle.digest(algorithm, new Uint8Array(data as ArrayBuffer)),
    },
    configurable: true,
  });
}
import {
  clearFavorites,
  deleteFavorite,
  fileFavoriteId,
  hashBlob,
  listFavorites,
  normalizeGifUrl,
  putFavorite,
  urlFavoriteId,
} from './gifFavorites';
import { useGifFavoritesStore } from '../stores/gifFavoritesStore';

describe('gifFavorites ids', () => {
  it('trims the URL and prefixes it', () => {
    expect(normalizeGifUrl('  https://x/y.gif  ')).toBe('https://x/y.gif');
    expect(urlFavoriteId('  https://x/y.gif ')).toBe('url:https://x/y.gif');
    expect(fileFavoriteId('abc')).toBe('file:abc');
  });
});

describe('gifFavorites database', () => {
  beforeEach(async () => { await clearFavorites(); });

  it('lists favourites newest first', async () => {
    await putFavorite({ id: 'url:a', kind: 'url', url: 'a', addedAt: 1000 });
    await putFavorite({ id: 'url:b', kind: 'url', url: 'b', addedAt: 2000 });
    const list = await listFavorites();
    expect(list.map((f) => f.id)).toEqual(['url:b', 'url:a']);
  });

  it('deletes a favourite', async () => {
    await putFavorite({ id: 'url:a', kind: 'url', url: 'a', addedAt: 1000 });
    await deleteFavorite('url:a');
    expect(await listFavorites()).toEqual([]);
  });

  it('keeps a file favourite’s blob', async () => {
    // A Node Blob round-trips through fake-indexeddb's structured clone in
    // jsdom; jsdom's own Blob does not.
    const blob = new NodeBlob([new Uint8Array([1, 2, 3])], { type: 'image/gif' });
    await putFavorite({ id: 'file:x', kind: 'file', blob: blob as unknown as Blob, mimeType: 'image/gif', addedAt: 1000 });
    const [favorite] = await listFavorites();
    expect(favorite?.kind).toBe('file');
    expect(favorite?.blob?.size).toBe(3);
    expect(favorite?.blob?.type).toBe('image/gif');
  });
});

describe('hashBlob', () => {
  it('is deterministic and 64 hex chars', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
    const first = await hashBlob(blob);
    expect(first).toBe(await hashBlob(blob));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different bytes', async () => {
    expect(await hashBlob(new Blob([new Uint8Array([1])])))
      .not.toBe(await hashBlob(new Blob([new Uint8Array([2])])));
  });
});

describe('gifFavoritesStore', () => {
  beforeEach(async () => {
    await clearFavorites();
    useGifFavoritesStore.setState({ favorites: [], ids: new Set<string>(), loaded: false });
  });

  it('loads, adds and removes', async () => {
    await useGifFavoritesStore.getState().load();
    expect(useGifFavoritesStore.getState().loaded).toBe(true);

    await useGifFavoritesStore.getState().put({ id: 'url:a', kind: 'url', url: 'a', addedAt: 1 });
    expect(useGifFavoritesStore.getState().ids.has('url:a')).toBe(true);

    await useGifFavoritesStore.getState().remove('url:a');
    expect(useGifFavoritesStore.getState().ids.has('url:a')).toBe(false);
  });
});
