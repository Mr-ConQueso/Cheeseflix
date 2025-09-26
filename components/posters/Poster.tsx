import { View } from "react-native";
import { OptimizedImage } from "../OptimizedImage";

type PosterProps = {
  id?: string | null;
  url?: string | null;
  showProgress?: boolean;
  blurhash?: string | null;
  priority?: "low" | "normal" | "high";
};

const Poster: React.FC<PosterProps> = ({
  id,
  url,
  blurhash,
  priority = "normal",
}) => {
  if (!id && !url)
    return (
      <View
        className='border border-neutral-900'
        style={{
          aspectRatio: "10/15",
        }}
      />
    );

  return (
    <View className='rounded-lg overflow-hidden border border-neutral-900'>
      <OptimizedImage
        placeholder={
          blurhash
            ? {
                blurhash,
              }
            : null
        }
        key={id}
        id={id!}
        source={
          url
            ? {
                uri: url,
              }
            : null
        }
        priority={priority}
        contentFit='cover'
        style={{
          aspectRatio: "10/15",
        }}
      />
    </View>
  );
};

export default Poster;
