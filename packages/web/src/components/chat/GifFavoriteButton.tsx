import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGifFavoritesStore } from '../../stores/gifFavoritesStore';
import { useUIStore } from '../../stores/uiStore';
import {
  fileFavoriteId,
  hashBlob,
  urlFavoriteId,
  type GifFavorite,
} from '../../utils/gifFavorites';

/** What the star is attached to. */
export type GifFavoriteSource =
  | { kind: 'url'; url: string; previewUrl?: string; width?: number; height?: number }
  | { kind: 'file'; attachmentUrl: string; mimeType: string; width?: number; height?: number };

/**
 * Fetched bytes + SHA-256, cached per attachment URL. Hashing a file means
 * downloading it, so this is done lazily on hover and reused on later hovers.
 */
const fileIdentityCache = new Map<string, Promise<{ hash: string; blob: Blob }>>();

function loadFileIdentity(attachmentUrl: string): Promise<{ hash: string; blob: Blob }> {
  const cached = fileIdentityCache.get(attachmentUrl);
  if (cached) return cached;
  const promise = (async () => {
    const response = await fetch(attachmentUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return { hash: await hashBlob(blob), blob };
  })();
  // Do not cache a failure — a transient network error must be retryable.
  promise.catch(() => fileIdentityCache.delete(attachmentUrl));
  fileIdentityCache.set(attachmentUrl, promise);
  return promise;
}

function StarIcon({ filled }: { filled: boolean }) {
  const path = 'M12 2.6l2.93 5.94 6.55.95-4.74 4.62 1.12 6.53L12 17.56l-5.86 3.08 1.12-6.53L2.52 9.49l6.55-.95L12 2.6z';
  return filled ? (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

/**
 * A small star that fades in over a GIF in chat. Filled when the GIF is already
 * in the local favourites, outlined otherwise; clicking toggles it.
 *
 * URL GIFs are keyed by their link; uploaded GIFs are keyed by the SHA-256 of
 * their bytes, so the same file shows as favourited wherever it appears.
 */
export function GifFavoriteButton({ source }: { source: GifFavoriteSource }) {
  const { t } = useTranslation(['chat']);
  const load = useGifFavoritesStore((s) => s.load);
  const ids = useGifFavoritesStore((s) => s.ids);
  const put = useGifFavoritesStore((s) => s.put);
  const remove = useGifFavoritesStore((s) => s.remove);
  const addToast = useUIStore((s) => s.addToast);

  const [fileIdentity, setFileIdentity] = useState<{ hash: string; blob: Blob } | null>(null);
  const [checking, setChecking] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [pulse, setPulse] = useState(false);

  useEffect(() => { void load(); }, [load]);

  const favoriteId = source.kind === 'url'
    ? urlFavoriteId(source.url)
    : fileIdentity
      ? fileFavoriteId(fileIdentity.hash)
      : null;
  const isFavorited = favoriteId !== null && ids.has(favoriteId);

  const ensureFileIdentity = useCallback(async (): Promise<{ hash: string; blob: Blob } | null> => {
    if (fileIdentity) return fileIdentity;
    setChecking(true);
    try {
      const identity = await loadFileIdentity(source.kind === 'file' ? source.attachmentUrl : '');
      setFileIdentity(identity);
      return identity;
    } catch {
      setUnavailable(true);
      return null;
    } finally {
      setChecking(false);
    }
  }, [fileIdentity, source]);

  const handleHover = useCallback(() => {
    if (source.kind === 'file' && !fileIdentity && !checking && !unavailable) {
      void ensureFileIdentity();
    }
  }, [source, fileIdentity, checking, unavailable, ensureFileIdentity]);

  const toggle = useCallback(async () => {
    let id: string;
    let favorite: GifFavorite;

    if (source.kind === 'url') {
      id = urlFavoriteId(source.url);
      favorite = {
        id,
        kind: 'url',
        url: source.url,
        previewUrl: source.previewUrl,
        width: source.width,
        height: source.height,
        addedAt: Date.now(),
      };
    } else {
      const identity = await ensureFileIdentity();
      if (!identity) return;
      id = fileFavoriteId(identity.hash);
      favorite = {
        id,
        kind: 'file',
        blob: identity.blob,
        mimeType: source.mimeType,
        width: source.width,
        height: source.height,
        addedAt: Date.now(),
      };
    }

    try {
      if (ids.has(id)) {
        await remove(id);
      } else {
        await put(favorite);
        setPulse(true);
        window.setTimeout(() => setPulse(false), 220);
      }
    } catch (err) {
      console.warn('[gifFavorites] toggle failed:', err);
      addToast(t('chat:gif.favoriteFailed'), 'warning', 4000);
    }
  }, [ids, source, ensureFileIdentity, remove, put, addToast, t]);

  if (unavailable) return null;

  const label = isFavorited ? t('chat:gif.removeFavorite') : t('chat:gif.addFavorite');

  return (
    <button
      type="button"
      onMouseEnter={handleHover}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        void toggle();
      }}
      aria-pressed={isFavorited}
      aria-label={label}
      title={label}
      style={pulse ? { transform: 'scale(1.25)' } : undefined}
      className={`absolute top-1.5 left-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white shadow-sm backdrop-blur-sm transition-all duration-200 opacity-0 scale-90 group-hover/gif:opacity-100 group-hover/gif:scale-100 hover:bg-black/75 active:scale-90 ${isFavorited ? 'text-accent-amber' : ''}`}
    >
      {checking ? (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/60 border-t-transparent" />
      ) : (
        <StarIcon filled={isFavorited} />
      )}
    </button>
  );
}
