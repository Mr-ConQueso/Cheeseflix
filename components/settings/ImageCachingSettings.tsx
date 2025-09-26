import React from "react";
import { useTranslation } from "react-i18next";
import { Switch, TextInput, View } from "react-native";
import { useSettings } from "@/utils/atoms/settings";
import { Text } from "../common/Text";
import { ListGroup } from "../list/ListGroup";
import { ListItem } from "../list/ListItem";

export const ImageCachingSettings: React.FC = ({ ...props }) => {
  const { settings, updateSettings } = useSettings();
  const { t } = useTranslation();

  const handleCacheSizeChange = (value: string) => {
    const size = parseInt(value, 10) || 500;
    // Ensure minimum 50MB and maximum 2000MB (2GB)
    const clampedSize = Math.max(50, Math.min(2000, size));
    updateSettings({ imageCacheMaxSizeMB: clampedSize });
  };

  return (
    <View {...props}>
      <ListGroup title={t("home.settings.image_caching.title")}>
        <ListItem title={t("home.settings.image_caching.enable_caching")}>
          <Switch
            value={settings?.enableImageCaching ?? false}
            onValueChange={(enableImageCaching) =>
              updateSettings({ enableImageCaching })
            }
          />
        </ListItem>
        <ListItem title={t("home.settings.image_caching.max_cache_size")}>
          <View className='flex-row items-center'>
            <TextInput
              value={(settings?.imageCacheMaxSizeMB ?? 500).toString()}
              onChangeText={handleCacheSizeChange}
              keyboardType='numeric'
              className='text-right text-white bg-neutral-800 px-2 py-1 rounded w-16'
              maxLength={4}
            />
            <Text className='ml-1 text-neutral-400'>MB</Text>
          </View>
        </ListItem>
        <View className='px-4 pb-2'>
          <Text className='text-xs text-neutral-500'>
            {t("home.settings.image_caching.description")}
          </Text>
        </View>
      </ListGroup>
    </View>
  );
};
