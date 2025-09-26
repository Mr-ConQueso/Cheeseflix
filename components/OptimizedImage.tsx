import { Image, type ImageProps } from "expo-image";
import React from "react";
import { useSettings } from "@/utils/atoms/settings";

// Create a placeholder image from assets (using existing icon)
const placeholderImage = require("../assets/images/icon.png");

interface OptimizedImageProps extends Omit<ImageProps, "placeholder"> {
  source: { uri: string } | null;
  priority?: "low" | "normal" | "high";
  enableCaching?: boolean;
  placeholder?: any;
}

export const OptimizedImage: React.FC<OptimizedImageProps> = ({
  source,
  priority = "normal",
  enableCaching,
  placeholder = placeholderImage,
  contentFit = "cover",
  transition = 200,
  ...props
}) => {
  const { settings } = useSettings();
  const shouldEnableCaching =
    enableCaching ?? settings?.enableImageCaching ?? false;
  // Generate recycling key for better memory management
  const recyclingKey = React.useMemo(() => {
    if (typeof source === "object" && source?.uri) {
      // Use URL path as recycling key for better memory reuse
      try {
        const url = new URL(source.uri);
        return `${url.pathname}${url.search}`;
      } catch {
        return source.uri;
      }
    }
    return undefined;
  }, [source]);

  return (
    <Image
      {...props}
      source={source}
      cachePolicy={shouldEnableCaching ? "memory-disk" : "none"}
      recyclingKey={recyclingKey}
      placeholder={placeholder}
      contentFit={contentFit}
      transition={transition}
      priority={priority}
    />
  );
};
