import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { GifResult } from '@backspace/shared';
import { useGifFavoritesStore } from '../../stores/gifFavoritesStore';
import type { GifFavorite } from '../../utils/gifFavorites';

/** What the picker hands back when a GIF is chosen. */
export type GifSelection =
  | { kind: 'url'; url: string }
  | { kind: 'file'; blob: Blob; mimeType: string; width?: number; height?: number };

interface GifPickerProps {
  onGifSelect: (gif: GifSelection) => void;
  /**
   * Mobile rendering: drop the desktop fixed dimensions and let the picker
   * fill its parent (a bottom sheet that controls width + max-height).
   */
  mobile?: boolean;
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 2.6l2.93 5.94 6.55.95-4.74 4.62 1.12 6.53L12 17.56l-5.86 3.08 1.12-6.53L2.52 9.49l6.55-.95L12 2.6z" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/** A favourited file is rendered from its stored blob; the URL is created per mount. */
function FavoriteThumb({ favorite, onSelect }: { favorite: GifFavorite; onSelect: () => void }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (favorite.kind !== 'file' || !favorite.blob) return;
    const url = URL.createObjectURL(favorite.blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [favorite]);

  const src = favorite.kind === 'url' ? (favorite.previewUrl ?? favorite.url) : objectUrl;
  if (!src) return null;

  return (
    <button
      onClick={onSelect}
      className="w-full mb-1.5 rounded-lg overflow-hidden hover:ring-2 hover:ring-accent-primary transition-all break-inside-avoid"
    >
      <img
        src={src}
        alt=""
        className="w-full object-cover rounded-lg"
        loading="lazy"
        style={favorite.width && favorite.height ? { aspectRatio: `${favorite.width}/${favorite.height}` } : undefined}
      />
    </button>
  );
}

export function GifPicker({ onGifSelect, mobile = false }: GifPickerProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [view, setView] = useState<'browse' | 'favorites'>('browse');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextPos, setNextPos] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const favorites = useGifFavoritesStore((s) => s.favorites);
  const loadFavorites = useGifFavoritesStore((s) => s.load);

  useEffect(() => { void loadFavorites(); }, [loadFavorites]);

  // Debounce search query
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Fetch results when debounced query changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResults([]);
    setNextPos('');

    const fetchGifs = async () => {
      try {
        const data = debouncedQuery.trim()
          ? await api.gif.search(debouncedQuery.trim(), 30)
          : await api.gif.trending(30);
        if (!cancelled) {
          setResults(data.results);
          setNextPos(data.next);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };
    fetchGifs();
    return () => { cancelled = true; };
  }, [debouncedQuery]);

  // Infinite scroll
  const handleScroll = useCallback(() => {
    if (view !== 'browse') return;
    const el = scrollRef.current;
    if (!el || loadingMore || !nextPos) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
      setLoadingMore(true);
      const fetchMore = async () => {
        try {
          const data = debouncedQuery.trim()
            ? await api.gif.search(debouncedQuery.trim(), 30, nextPos)
            : await api.gif.trending(30, nextPos);
          setResults((prev) => [...prev, ...data.results]);
          setNextPos(data.next);
        } finally {
          setLoadingMore(false);
        }
      };
      fetchMore();
    }
  }, [view, loadingMore, nextPos, debouncedQuery]);

  // Prevent keyboard events from bubbling
  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
  };

  const selectFavorite = (favorite: GifFavorite) => {
    if (favorite.kind === 'url' && favorite.url) {
      onGifSelect({ kind: 'url', url: favorite.url });
    } else if (favorite.kind === 'file' && favorite.blob) {
      onGifSelect({
        kind: 'file',
        blob: favorite.blob,
        mimeType: favorite.mimeType ?? 'image/gif',
        width: favorite.width,
        height: favorite.height,
      });
    }
  };

  // Mobile: fill parent (sheet sets width + max-height). Desktop: fixed dims
  // matching the legacy popover footprint.
  const rootClass = mobile
    ? 'flex flex-col flex-1 min-h-0 w-full'
    : 'flex flex-col h-[390px] w-[390px]';

  return (
    <div className={rootClass} onKeyDown={handleKeyDown}>
      {view === 'favorites' ? (
        <div className="flex items-center gap-1.5 px-3 pt-2 pb-1.5 shrink-0">
          <button
            onClick={() => setView('browse')}
            className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[13px] font-medium text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover transition-colors"
          >
            <BackIcon />
            {t('common:actions.back')}
          </button>
          <span className="flex items-center gap-1 text-[13px] font-semibold text-txt-primary">
            <StarIcon className="h-3.5 w-3.5 text-accent-amber" />
            {t('chat:gif.favorites')}
          </span>
        </div>
      ) : (
        <div className="px-3 pt-2 pb-1.5 shrink-0">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('chat:gif.searchPlaceholder')}
            className="input-search w-full"
            // Auto-focus only on desktop. On mobile this would force the OS
            // keyboard up the moment the sheet opens, hiding most of the grid.
            autoFocus={!mobile}
          />
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-1"
        onScroll={handleScroll}
      >
        {view === 'favorites' ? (
          favorites.length === 0 ? (
            <div className="flex items-center justify-center h-full text-txt-tertiary text-sm px-6 text-center">
              {t('chat:gif.favoritesEmpty')}
            </div>
          ) : (
            <div className="columns-2 gap-1.5 p-1">
              {favorites.map((favorite) => (
                <FavoriteThumb
                  key={favorite.id}
                  favorite={favorite}
                  onSelect={() => selectFavorite(favorite)}
                />
              ))}
            </div>
          )
        ) : loading ? (
          <div className="grid grid-cols-2 gap-1.5 p-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="bg-surface-elevated rounded-lg animate-pulse"
                style={{ height: 100 + Math.random() * 60 }}
              />
            ))}
          </div>
        ) : results.length === 0 ? (
          <div className="flex items-center justify-center h-full text-txt-tertiary text-sm">
            {debouncedQuery.trim() ? t('chat:gif.noResults') : t('chat:gif.noTrending')}
          </div>
        ) : (
          <div className="columns-2 gap-1.5 p-1">
            {/* The Favorites tile is the entry point, so it appears only once
                there is something in it — the star in chat is how you add one. */}
            {favorites.length > 0 && (
              <button
                onClick={() => setView('favorites')}
                className="w-full mb-1.5 rounded-lg overflow-hidden hover:ring-2 hover:ring-accent-primary transition-all break-inside-avoid"
              >
                <div className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 bg-surface-elevated text-txt-secondary">
                  <StarIcon className="h-6 w-6 text-accent-amber" />
                  <span className="text-xs font-medium">{t('chat:gif.favorites')}</span>
                </div>
              </button>
            )}
            {results.map((gif) => (
              <button
                key={gif.id}
                onClick={() => onGifSelect({ kind: 'url', url: gif.url })}
                className="w-full mb-1.5 rounded-lg overflow-hidden hover:ring-2 hover:ring-accent-primary transition-all break-inside-avoid"
              >
                <img
                  src={gif.previewUrl}
                  alt={gif.title}
                  className="w-full object-cover rounded-lg"
                  loading="lazy"
                  style={{
                    aspectRatio: gif.width && gif.height ? `${gif.width}/${gif.height}` : undefined,
                  }}
                />
              </button>
            ))}
          </div>
        )}
        {view === 'browse' && loadingMore && (
          <div className="flex justify-center py-2">
            <div className="w-5 h-5 border-2 border-txt-tertiary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      <div className="px-3 py-1 text-[10px] text-txt-tertiary text-right shrink-0">
        {t('chat:gif.attribution')}
      </div>
    </div>
  );
}
