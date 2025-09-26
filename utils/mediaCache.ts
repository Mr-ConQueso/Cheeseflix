import * as FileSystem from "expo-file-system";
import { Image } from "expo-image";
import { settingsAtom } from "@/utils/atoms/settings";
import { store } from "@/utils/store";

/**
 * Get cache size limit from settings
 * @returns Cache size limit in bytes
 */
const getCacheSizeLimit = () => {
  const settings = store.get(settingsAtom);
  return (settings?.imageCacheMaxSizeMB || 500) * 1024 * 1024; // Convert MB to bytes
};

/**
 * Preload poster images for better performance
 * Limits to first 10 URLs to avoid memory issues
 * @param urls Array of image URLs to preload
 */
export async function preloadPosters(urls: string[]): Promise<void> {
  const urlsToPreload = urls.slice(0, 10).filter(Boolean);

  try {
    await Promise.all(urlsToPreload.map((url) => Image.prefetch(url)));
  } catch (error) {
    console.warn("Failed to preload some posters:", error);
  }
}

/**
 * Clean up media cache when it exceeds maximum size
 * Implements basic LRU (Least Recently Used) removal strategy
 * Uses the configured cache size limit from settings
 */
export async function cleanupMediaCache(): Promise<void> {
  const maxSize = getCacheSizeLimit();
  const cacheDirectory = `${FileSystem.cacheDirectory}media/`;

  try {
    const info = await FileSystem.getInfoAsync(cacheDirectory);

    if (!info.exists || !info.isDirectory) {
      return;
    }

    // Check if cleanup is needed
    const totalSize = await getCacheDirectorySize(cacheDirectory);

    if (totalSize <= maxSize) {
      return;
    }

    // Get all files with their stats for LRU cleanup
    const files = await FileSystem.readDirectoryAsync(cacheDirectory);
    const fileStats = await Promise.all(
      files.map(async (filename) => {
        const filePath = `${cacheDirectory}${filename}`;
        const fileInfo = await FileSystem.getInfoAsync(filePath);
        return {
          path: filePath,
          size: fileInfo.exists && "size" in fileInfo ? fileInfo.size : 0,
          modificationTime:
            fileInfo.exists && "modificationTime" in fileInfo
              ? fileInfo.modificationTime
              : 0,
        };
      }),
    );

    // Sort by modification time (oldest first) for LRU removal
    const sortedFiles = fileStats.sort(
      (a, b) => a.modificationTime - b.modificationTime,
    );

    let currentSize = totalSize;
    const targetSize = maxSize * 0.8; // Clean to 80% of max size

    // Remove oldest files until we reach target size
    for (const file of sortedFiles) {
      if (currentSize <= targetSize) {
        break;
      }

      try {
        await FileSystem.deleteAsync(file.path, { idempotent: true });
        currentSize -= file.size;
      } catch (error) {
        console.warn(`Failed to delete cache file: ${file.path}`, error);
      }
    }

    console.log(
      `Cache cleanup completed. Reduced from ${(totalSize / 1e6).toFixed(2)}MB to ${(currentSize / 1e6).toFixed(2)}MB`,
    );
  } catch (error) {
    console.error("Failed to cleanup media cache:", error);
  }
}

/**
 * Calculate total size of cache directory
 * @param directory Directory path to calculate size for
 * @returns Total size in bytes
 */
async function getCacheDirectorySize(directory: string): Promise<number> {
  try {
    const files = await FileSystem.readDirectoryAsync(directory);
    const sizes = await Promise.all(
      files.map(async (filename) => {
        const filePath = `${directory}${filename}`;
        const info = await FileSystem.getInfoAsync(filePath);
        return info.exists && "size" in info ? info.size : 0;
      }),
    );

    return sizes.reduce((total: number, size: number) => total + size, 0);
  } catch {
    return 0;
  }
}

/**
 * Clear all cached media files
 * Useful for manual cache clearing or troubleshooting
 */
export async function clearMediaCache(): Promise<void> {
  const cacheDirectory = `${FileSystem.cacheDirectory}media/`;

  try {
    await FileSystem.deleteAsync(cacheDirectory, { idempotent: true });
    await FileSystem.makeDirectoryAsync(cacheDirectory, {
      intermediates: true,
    });
    console.log("Media cache cleared successfully");
  } catch (error) {
    console.error("Failed to clear media cache:", error);
  }
}

/**
 * Get current cache statistics
 * @returns Object with cache size information
 */
export async function getCacheStats(): Promise<{
  totalSize: number;
  fileCount: number;
  sizeFormatted: string;
}> {
  const cacheDirectory = `${FileSystem.cacheDirectory}media/`;

  try {
    const info = await FileSystem.getInfoAsync(cacheDirectory);

    if (!info.exists || !info.isDirectory) {
      return { totalSize: 0, fileCount: 0, sizeFormatted: "0 MB" };
    }

    const files = await FileSystem.readDirectoryAsync(cacheDirectory);
    const totalSize = await getCacheDirectorySize(cacheDirectory);

    return {
      totalSize,
      fileCount: files.length,
      sizeFormatted: `${(totalSize / 1e6).toFixed(2)} MB`,
    };
  } catch {
    return { totalSize: 0, fileCount: 0, sizeFormatted: "0 MB" };
  }
}
