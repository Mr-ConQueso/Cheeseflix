import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { apiAtom } from "@/providers/JellyfinProvider";
import { useSettings } from "@/utils/atoms/settings";
import { getItemImage } from "@/utils/getItemImage";
import {
  cleanupMediaCache,
  getCacheStats,
  preloadPosters,
} from "@/utils/mediaCache";

interface MediaCacheConfig {
  preloadLimit?: number; // number of images to preload, default 10
  autoCleanup?: boolean; // auto cleanup on cache size exceed, default true
}

interface MediaCacheStats {
  totalSize: number;
  fileCount: number;
  sizeFormatted: string;
}

/**
 * Hook for advanced media caching functionality
 * Provides preloading, cleanup, and cache management for Jellyfin media
 */
export function useMediaCache(config: MediaCacheConfig = {}) {
  const api = useAtomValue(apiAtom);
  const { settings } = useSettings();
  const { preloadLimit = 10, autoCleanup = true } = config;

  const imageCachingEnabled = settings?.enableImageCaching ?? false;

  const lastCleanupRef = useRef<number>(0);
  const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes

  /**
   * Preload poster images from a list of items
   * Automatically extracts image URLs from Jellyfin items
   */
  const preloadItemPosters = useCallback(
    async (items: BaseItemDto[]): Promise<void> => {
      if (!api || !items.length || !imageCachingEnabled) return;

      try {
        const urls: string[] = [];

        for (const item of items.slice(0, preloadLimit)) {
          const imageSource = getItemImage({
            item,
            api,
            variant: "Primary",
            quality: 80,
            width: 300,
          });

          if (imageSource?.uri) {
            urls.push(imageSource.uri);
          }
        }

        if (urls.length > 0) {
          await preloadPosters(urls);
          console.log(`Preloaded ${urls.length} poster images`);
        }
      } catch (error) {
        console.warn("Failed to preload item posters:", error);
      }
    },
    [api, preloadLimit, imageCachingEnabled],
  );

  /**
   * Preload backdrop images from a list of items
   */
  const preloadItemBackdrops = useCallback(
    async (items: BaseItemDto[]): Promise<void> => {
      if (!api || !items.length || !imageCachingEnabled) return;

      try {
        const urls: string[] = [];

        for (const item of items.slice(0, preloadLimit)) {
          const imageSource = getItemImage({
            item,
            api,
            variant: "Backdrop",
            quality: 80,
            width: 1280,
          });

          if (imageSource?.uri) {
            urls.push(imageSource.uri);
          }
        }

        if (urls.length > 0) {
          await preloadPosters(urls);
          console.log(`Preloaded ${urls.length} backdrop images`);
        }
      } catch (error) {
        console.warn("Failed to preload item backdrops:", error);
      }
    },
    [api, preloadLimit, imageCachingEnabled],
  );

  /**
   * Manual cache cleanup
   */
  const performCacheCleanup = useCallback(async (): Promise<void> => {
    await cleanupMediaCache();
    lastCleanupRef.current = Date.now();
  }, []);

  /**
   * Get current cache statistics
   */
  const getCacheStatistics = useCallback(async (): Promise<MediaCacheStats> => {
    return await getCacheStats();
  }, []);

  /**
   * Auto cleanup effect
   * Runs cleanup periodically if autoCleanup is enabled
   */
  useEffect(() => {
    if (!autoCleanup) return;

    const cleanup = async () => {
      const now = Date.now();
      if (now - lastCleanupRef.current > CLEANUP_INTERVAL) {
        try {
          await performCacheCleanup();
        } catch (error) {
          console.warn("Auto cleanup failed:", error);
        }
      }
    };

    // Initial cleanup check
    cleanup();

    // Set up interval for periodic cleanup
    const interval = setInterval(cleanup, CLEANUP_INTERVAL);

    return () => clearInterval(interval);
  }, [autoCleanup, performCacheCleanup]);

  /**
   * Preload images for continue watching items
   * These are high priority and should be loaded first
   */
  const preloadContinueWatchingImages = useCallback(
    async (items: BaseItemDto[]): Promise<void> => {
      if (!api || !items.length || !imageCachingEnabled) return;

      try {
        const urls: string[] = [];

        for (const item of items.slice(0, 5)) {
          // Limit to first 5 for priority
          // For episodes, prefer backdrop over primary
          const variant = item.Type === "Episode" ? "Backdrop" : "Primary";
          const imageSource = getItemImage({
            item,
            api,
            variant,
            quality: 90, // Higher quality for continue watching
            width: item.Type === "Episode" ? 500 : 300,
          });

          if (imageSource?.uri) {
            urls.push(imageSource.uri);
          }
        }

        if (urls.length > 0) {
          await preloadPosters(urls);
          console.log(`Preloaded ${urls.length} continue watching images`);
        }
      } catch (error) {
        console.warn("Failed to preload continue watching images:", error);
      }
    },
    [api, imageCachingEnabled],
  );

  return {
    preloadItemPosters,
    preloadItemBackdrops,
    preloadContinueWatchingImages,
    performCacheCleanup,
    getCacheStatistics,
  };
}
