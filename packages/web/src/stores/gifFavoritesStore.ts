import { create } from 'zustand';
import {
  deleteFavorite,
  listFavorites,
  putFavorite,
  type GifFavorite,
} from '../utils/gifFavorites';

/**
 * In-memory mirror of the GIF favourites IndexedDB store, so stars across the
 * whole chat react to a toggle without re-reading the database.
 *
 * `ids` is kept alongside the list so a star can subscribe to a single boolean
 * (`ids.has(id)`) and only re-render when its own state changes.
 */
interface GifFavoritesState {
  favorites: GifFavorite[];
  ids: Set<string>;
  loaded: boolean;
  /** Load once from IndexedDB. Idempotent. */
  load: () => Promise<void>;
  /** Add or replace a favourite (newest first). */
  put: (favorite: GifFavorite) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useGifFavoritesStore = create<GifFavoritesState>((set, get) => ({
  favorites: [],
  ids: new Set<string>(),
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const favorites = await listFavorites();
      set({ favorites, ids: new Set(favorites.map((f) => f.id)), loaded: true });
    } catch (err) {
      console.warn('[gifFavorites] load failed:', err);
      // Mark loaded so a broken store does not retry on every mount.
      set({ loaded: true });
    }
  },

  put: async (favorite) => {
    await putFavorite(favorite);
    set((state) => {
      const favorites = [favorite, ...state.favorites.filter((f) => f.id !== favorite.id)];
      return { favorites, ids: new Set(favorites.map((f) => f.id)) };
    });
  },

  remove: async (id) => {
    await deleteFavorite(id);
    set((state) => {
      const favorites = state.favorites.filter((f) => f.id !== id);
      return { favorites, ids: new Set(favorites.map((f) => f.id)) };
    });
  },
}));
