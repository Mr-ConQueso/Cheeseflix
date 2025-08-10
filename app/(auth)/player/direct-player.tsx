import {
  type BaseItemDto,
  type MediaSourceInfo,
  PlaybackOrder,
  type PlaybackProgressInfo,
  PlaybackStartInfo,
  RepeatMode,
} from "@jellyfin/sdk/lib/generated-client";
import {
  getPlaystateApi,
  getUserLibraryApi,
} from "@jellyfin/sdk/lib/utils/api";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { router, useGlobalSearchParams, useNavigation } from "expo-router";
import { useAtomValue } from "jotai";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Alert, Platform, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BITRATES } from "@/components/BitrateSelector";
import { Text } from "@/components/common/Text";
import { Loader } from "@/components/Loader";
import { Controls } from "@/components/video-player/controls/Controls";
import { getDownloadedFileUrl } from "@/hooks/useDownloadedFileOpener";
import { useHaptic } from "@/hooks/useHaptic";
import { useInvalidatePlaybackProgressCache } from "@/hooks/useRevalidatePlaybackProgressCache";
import { useWebSocket } from "@/hooks/useWebsockets";
import { VlcPlayerView } from "@/modules";
import type {
  PipStartedPayload,
  PlaybackStatePayload,
  ProgressUpdatePayload,
  VlcPlayerViewRef,
} from "@/modules/VlcPlayer.types";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { useSettings } from "@/utils/atoms/settings";
import { getStreamUrl } from "@/utils/jellyfin/media/getStreamUrl";
import { writeToLog } from "@/utils/log";
import { storage } from "@/utils/mmkv";
import generateDeviceProfile from "@/utils/profiles/native";
import { msToTicks, ticksToSeconds } from "@/utils/time";

/* ---------- helpers ---------- */

const downloadProvider = !Platform.isTV
  ? require("@/providers/DownloadProvider")
  : { useDownload: () => null };

const IGNORE_SAFE_AREAS_KEY = "video_player_ignore_safe_areas";

/* ---------- performance monitor ---------- */

const usePerformanceMonitoring = (name: string) => {
  useEffect(() => {
    const start = performance.now();
    return () => {
      const end = performance.now();
      const ms = end - start;
      if (ms > 16.67) {
        // >1 frame at 60 fps
        console.warn(`[Perf] ${name} render took ${ms.toFixed(1)} ms`);
      }
    };
  });
};

/* ---------- reducer ---------- */

interface VideoState {
  isPlaying: boolean;
  isMuted: boolean;
  isBuffering: boolean;
  isVideoLoaded: boolean;
  isPipStarted: boolean;
}
type VideoAction =
  | { type: "PLAYING_CHANGED"; value: boolean }
  | { type: "BUFFERING_CHANGED"; value: boolean }
  | { type: "VIDEO_LOADED" }
  | { type: "MUTED_CHANGED"; value: boolean }
  | { type: "PIP_CHANGED"; value: boolean };

const videoReducer = (state: VideoState, action: VideoAction): VideoState => {
  switch (action.type) {
    case "PLAYING_CHANGED":
      return { ...state, isPlaying: action.value };
    case "BUFFERING_CHANGED":
      return { ...state, isBuffering: action.value };
    case "VIDEO_LOADED":
      return { ...state, isVideoLoaded: true, isBuffering: false };
    case "MUTED_CHANGED":
      return { ...state, isMuted: action.value };
    case "PIP_CHANGED":
      return { ...state, isPipStarted: action.value };
    default:
      return state;
  }
};

const initialVideoState: VideoState = {
  isPlaying: false,
  isMuted: false,
  isBuffering: true,
  isVideoLoaded: false,
  isPipStarted: false,
};

/* ---------- main component ---------- */

export default function DirectPlayerPage() {
  usePerformanceMonitoring("DirectPlayerPage");

  /* ---------- refs & atoms ---------- */
  const videoRef = useRef<VlcPlayerViewRef>(null);
  const user = useAtomValue(userAtom);
  const api = useAtomValue(apiAtom);

  const navigation = useNavigation();
  const { t } = useTranslation();

  /* ---------- consolidated playback state ---------- */
  const [videoState, dispatch] = useReducer(videoReducer, initialVideoState);

  /* ---------- misc UI state ---------- */
  const [showControls, _setShowControls] = useState(true);
  const [ignoreSafeAreas, setIgnoreSafeAreas] = useState(() => {
    return storage.getBoolean(IGNORE_SAFE_AREAS_KEY) ?? false;
  });
  const [isPlaybackStopped, setIsPlaybackStopped] = useState(false);

  const insets = useSafeAreaInsets();
  const [settings] = useSettings();

  const progress = useSharedValue(0);
  const isSeeking = useSharedValue(false);
  const cacheProgress = useSharedValue(0);
  const lightHapticFeedback = useHaptic("light");
  const VolumeManager = Platform.isTV
    ? null
    : require("react-native-volume-manager");

  /* ---------- URL params ---------- */
  const {
    itemId,
    audioIndex: audioIndexStr,
    subtitleIndex: subtitleIndexStr,
    mediaSourceId,
    bitrateValue: bitrateValueStr,
    offline: offlineStr,
    playbackPosition: playbackPositionFromUrl,
  } = useGlobalSearchParams<{
    itemId: string;
    audioIndex: string;
    subtitleIndex: string;
    mediaSourceId: string;
    bitrateValue: string;
    offline: string;
    playbackPosition?: string;
  }>();

  const offline = offlineStr === "true";
  const audioIndex = audioIndexStr ? parseInt(audioIndexStr, 10) : undefined;
  const subtitleIndex = subtitleIndexStr ? parseInt(subtitleIndexStr, 10) : -1;
  const bitrateValue = bitrateValueStr
    ? parseInt(bitrateValueStr, 10)
    : BITRATES[0].value;

  /* ---------- stable callbacks ---------- */
  const setShowControls = useCallback(
    (show: boolean) => {
      _setShowControls(show);
      lightHapticFeedback();
    },
    [lightHapticFeedback],
  );

  useEffect(() => {
    storage.set(IGNORE_SAFE_AREAS_KEY, ignoreSafeAreas);
  }, [ignoreSafeAreas]);

  /* ---------- data fetching ---------- */

  /* item */
  const [item, setItem] = useState<BaseItemDto | null>(null);
  const [itemStatus, setItemStatus] = useState({
    isLoading: true,
    isError: false,
  });
  const getDownloadedItem = downloadProvider.useDownload();

  const getInitialPlaybackTicks = useCallback((): number => {
    if (playbackPositionFromUrl) {
      return parseInt(playbackPositionFromUrl, 10);
    }
    return item?.UserData?.PlaybackPositionTicks ?? 0;
  }, [playbackPositionFromUrl, item]);

  useEffect(() => {
    if (!itemId) return;

    const controller = new AbortController();
    (async () => {
      setItemStatus({ isLoading: true, isError: false });
      try {
        let fetchedItem: BaseItemDto | null = null;
        if (offline && !Platform.isTV) {
          const data = await getDownloadedItem.getDownloadedItem(itemId);
          fetchedItem = data?.item as BaseItemDto | null;
        } else {
          const res = await getUserLibraryApi(api!).getItem(
            { itemId, userId: user?.Id },
            { signal: controller.signal },
          );
          fetchedItem = res.data;
        }
        if (!controller.signal.aborted) {
          setItem(fetchedItem);
          setItemStatus({ isLoading: false, isError: false });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("Failed to fetch item:", error);
          setItemStatus({ isLoading: false, isError: true });
        }
      }
    })();

    return () => controller.abort();
  }, [itemId, offline, api, user?.Id, getDownloadedItem]);

  /* stream */
  interface Stream {
    mediaSource: MediaSourceInfo;
    sessionId: string;
    url: string;
  }
  const [stream, setStream] = useState<Stream | null>(null);
  const [streamStatus, setStreamStatus] = useState({
    isLoading: true,
    isError: false,
  });

  useEffect(() => {
    const fetchStreamData = async () => {
      setStreamStatus({ isLoading: true, isError: false });
      try {
        const native = await generateDeviceProfile();
        let result: Stream | null = null;

        if (offline && !Platform.isTV) {
          const data = await getDownloadedItem.getDownloadedItem(itemId);
          if (!data?.mediaSource) return;
          const url = await getDownloadedFileUrl(data.item.Id!);
          result = { mediaSource: data.mediaSource, sessionId: "", url };
        } else if (item) {
          const res = await getStreamUrl({
            api,
            item,
            startTimeTicks: getInitialPlaybackTicks(),
            userId: user?.Id,
            audioStreamIndex: audioIndex,
            maxStreamingBitrate: bitrateValue,
            mediaSourceId,
            subtitleStreamIndex: subtitleIndex,
            deviceProfile: native,
          });
          if (!res) return;
          const { mediaSource, sessionId, url } = res;
          if (!sessionId || !mediaSource || !url) {
            Alert.alert(
              t("player.error"),
              t("player.failed_to_get_stream_url"),
            );
            return;
          }
          result = { mediaSource, sessionId, url };
        }

        setStream(result);
        setStreamStatus({ isLoading: false, isError: false });
      } catch (error) {
        console.error("Failed to fetch stream:", error);
        setStreamStatus({ isLoading: false, isError: true });
      }
    };

    fetchStreamData();
  }, [
    itemId,
    mediaSourceId,
    bitrateValue,
    api,
    item,
    user?.Id,
    offline,
    getInitialPlaybackTicks,
    audioIndex,
    subtitleIndex,
  ]);

  /* ---------- playback API reporting ---------- */

  const revalidateProgressCache = useInvalidatePlaybackProgressCache();

  const currentPlayStateInfo = useMemo(() => {
    if (!stream) return null;
    return {
      itemId: item?.Id!,
      audioStreamIndex: audioIndex,
      subtitleStreamIndex: subtitleIndex,
      mediaSourceId,
      positionTicks: msToTicks(progress.get()),
      isPaused: !videoState.isPlaying,
      playMethod: stream.url.includes("m3u8") ? "Transcode" : "DirectStream",
      playSessionId: stream.sessionId,
      isMuted: videoState.isMuted,
      canSeek: true,
      repeatMode: RepeatMode.RepeatNone,
      playbackOrder: PlaybackOrder.Default,
    };
  }, [
    item?.Id,
    audioIndex,
    subtitleIndex,
    mediaSourceId,
    progress,
    videoState.isPlaying,
    videoState.isMuted,
    stream,
  ]);

  const reportPlaybackProgress = useCallback(async () => {
    if (!api || offline || !stream || !currentPlayStateInfo) return;
    await getPlaystateApi(api).reportPlaybackProgress({
      playbackProgressInfo: currentPlayStateInfo as PlaybackProgressInfo,
    });
  }, [api, offline, stream, currentPlayStateInfo]);

  const reportPlaybackStopped = useCallback(async () => {
    if (offline || !stream) return;
    await getPlaystateApi(api!).onPlaybackStopped({
      itemId: item?.Id!,
      mediaSourceId,
      positionTicks: msToTicks(progress.get()),
      playSessionId: stream.sessionId,
    });
    revalidateProgressCache();
  }, [
    api,
    item?.Id,
    mediaSourceId,
    progress,
    stream,
    offline,
    revalidateProgressCache,
  ]);

  /* ---------- UI / player actions ---------- */

  const togglePlay = useCallback(async () => {
    lightHapticFeedback();
    const playing = videoState.isPlaying;
    dispatch({ type: "PLAYING_CHANGED", value: !playing });

    if (playing) {
      await videoRef.current?.pause();
      reportPlaybackProgress();
    } else {
      await videoRef.current?.play();
      await getPlaystateApi(api!).reportPlaybackStart({
        playbackStartInfo: currentPlayStateInfo as PlaybackStartInfo,
      });
    }
  }, [
    videoState.isPlaying,
    lightHapticFeedback,
    reportPlaybackProgress,
    api,
    currentPlayStateInfo,
  ]);

  /* ---------- React Navigation cleanup ---------- */

  const stop = useCallback(() => {
    reportPlaybackStopped();
    setIsPlaybackStopped(true);
    videoRef.current?.stop();
  }, [reportPlaybackStopped]);

  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", stop);
    return unsubscribe;
  }, [navigation, stop]);

  /* ---------- VLC init options ---------- */

  const optimizedInitOptions = useMemo(() => {
    const opts = [`--sub-text-scale=${settings.subtitleSize}`];

    // reduce buffering memory
    opts.push("--network-caching=300", "--file-caching=300");

    if (Platform.OS === "android") opts.push("--aout=opensles");
    if (Platform.OS === "ios") opts.push("--ios-hw-decoding");

    // pre-select tracks
    const notTranscoding = !stream?.mediaSource.TranscodingUrl;
    const allAudio =
      stream?.mediaSource.MediaStreams?.filter((s) => s.Type === "Audio") ?? [];
    const allSubs =
      stream?.mediaSource.MediaStreams?.filter(
        (s) => s.Type === "Subtitle",
      )?.sort((a, b) => Number(a.IsExternal) - Number(b.IsExternal)) ?? [];

    if (subtitleIndex >= 0) {
      const chosenSubtitleTrack = allSubs.find(
        (s) => s.Index === subtitleIndex,
      );
      const textSubs = allSubs.filter((s) => s.IsTextSubtitleStream);
      if (
        chosenSubtitleTrack &&
        (notTranscoding || chosenSubtitleTrack.IsTextSubtitleStream)
      ) {
        const finalIdx = notTranscoding
          ? allSubs.indexOf(chosenSubtitleTrack)
          : textSubs.indexOf(chosenSubtitleTrack);
        opts.push(`--sub-track=${finalIdx}`);
      }
    }
    if (notTranscoding && audioIndex !== undefined) {
      const chosenAudioTrack = allAudio.find((a) => a.Index === audioIndex);
      if (chosenAudioTrack)
        opts.push(`--audio-track=${allAudio.indexOf(chosenAudioTrack)}`);
    }

    return opts;
  }, [settings.subtitleSize, stream?.mediaSource, subtitleIndex, audioIndex]);

  /* ---------- picture-in-picture ---------- */

  const onPipStarted = useCallback((e: PipStartedPayload) => {
    dispatch({ type: "PIP_CHANGED", value: e.nativeEvent.pipStarted });
  }, []);

  /* ---------- progress ---------- */

  const onProgress = useCallback(
    (data: ProgressUpdatePayload) => {
      if (isSeeking.get() || isPlaybackStopped) return;

      if (videoState.isBuffering)
        dispatch({ type: "BUFFERING_CHANGED", value: false });

      const { currentTime } = data.nativeEvent;
      progress.set(currentTime);

      router.setParams({ playbackPosition: msToTicks(currentTime).toString() });

      if (!offline) reportPlaybackProgress();
    },
    [
      isSeeking,
      isPlaybackStopped,
      progress,
      offline,
      reportPlaybackProgress,
      videoState.isBuffering,
    ],
  );

  /* ---------- playback state listener ---------- */

  const onPlaybackStateChanged = useCallback(
    async (e: PlaybackStatePayload) => {
      const { state, isBuffering, isPlaying } = e.nativeEvent;

      switch (state) {
        case "Playing":
          dispatch({ type: "PLAYING_CHANGED", value: true });
          await activateKeepAwakeAsync();
          reportPlaybackProgress();
          break;
        case "Paused":
          dispatch({ type: "PLAYING_CHANGED", value: false });
          await deactivateKeepAwake();
          reportPlaybackProgress();
          break;
        default:
          // fallback
          dispatch({ type: "BUFFERING_CHANGED", value: !!isBuffering });
          dispatch({ type: "PLAYING_CHANGED", value: !!isPlaying });
      }
    },
    [reportPlaybackProgress],
  );

  /* ---------- web socket / remote ---------- */

  /* volume handlers */
  const [previousVolume, setPreviousVolume] = useState<number | null>(null);

  const volumeUpCb = useCallback(async () => {
    if (Platform.isTV) return;
    const { volume } = await VolumeManager.getVolume();
    await VolumeManager.setVolume(Math.min(volume + 0.1, 1));
  }, []);

  const volumeDownCb = useCallback(async () => {
    if (Platform.isTV) return;
    const { volume } = await VolumeManager.getVolume();
    await VolumeManager.setVolume(Math.max(volume - 0.1, 0));
  }, []);

  const setVolumeCb = useCallback(async (v: number) => {
    if (Platform.isTV) return;
    await VolumeManager.setVolume(Math.max(0, Math.min(v, 100)) / 100);
  }, []);

  const toggleMuteCb = useCallback(async () => {
    if (Platform.isTV) return;
    const { volume } = await VolumeManager.getVolume();
    const percent = volume * 100;
    if (percent > 0) {
      setPreviousVolume(percent);
      await VolumeManager.setVolume(0);
      dispatch({ type: "MUTED_CHANGED", value: true });
    } else {
      const restore = previousVolume || 50;
      await VolumeManager.setVolume(restore / 100);
      setPreviousVolume(null);
      dispatch({ type: "MUTED_CHANGED", value: false });
    }
  }, [previousVolume]);

  useWebSocket({
    isPlaying: videoState.isPlaying,
    togglePlay,
    stopPlayback: stop,
    offline,
    toggleMute: toggleMuteCb,
    volumeUp: volumeUpCb,
    volumeDown: volumeDownCb,
    setVolume: setVolumeCb,
  });

  /* ---------- start position ---------- */

  const startPosition = useMemo(
    () => (offline ? 0 : ticksToSeconds(getInitialPlaybackTicks())),
    [offline, getInitialPlaybackTicks],
  );

  /* ---------- subtitle & audio helpers ---------- */

  const _allAudio =
    stream?.mediaSource.MediaStreams?.filter((a) => a.Type === "Audio") ?? [];
  const allSubs =
    stream?.mediaSource.MediaStreams?.filter(
      (s) => s.Type === "Subtitle",
    )?.sort((a, b) => Number(a.IsExternal) - Number(b.IsExternal)) ?? [];

  const externalSubtitles = allSubs
    .filter((s) => s.DeliveryMethod === "External")
    .map((s) => ({
      name: s.DisplayTitle,
      DeliveryUrl: api?.basePath + s.DeliveryUrl,
    }));

  /* ---------- player helpers (memoised safe wrappers) ---------- */
  const safeMethod =
    <T extends unknown[]>(
      fn: ((...args: T) => any) | undefined,
      name: string,
    ) =>
    async (...args: T) => {
      if (!fn) {
        writeToLog("ERROR", `${name} fn missing`, {
          isVideoLoaded: videoState.isVideoLoaded,
        });
        return;
      }
      try {
        return await fn(...args);
      } catch (error) {
        writeToLog("ERROR", `Error in ${name}`, {
          error,
          isVideoLoaded: videoState.isVideoLoaded,
        });
      }
    };

  const play = useCallback(
    () => safeMethod(videoRef.current?.play, "play")(),
    [videoRef],
  );
  const pause = useCallback(
    () => safeMethod(videoRef.current?.pause, "pause")(),
    [videoRef],
  );
  const startPictureInPicture = useCallback(
    () => safeMethod(videoRef.current?.startPictureInPicture, "PiP")(),
    [videoRef],
  );
  const seek = useCallback(
    (t: number) => safeMethod(videoRef.current?.seekTo, "seek")(t),
    [videoRef],
  );
  const getAudioTracks = useCallback(
    () => safeMethod(videoRef.current?.getAudioTracks, "getAudioTracks")(),
    [videoRef],
  );
  const getSubtitleTracks = useCallback(
    () =>
      safeMethod(videoRef.current?.getSubtitleTracks, "getSubtitleTracks")(),
    [videoRef],
  );
  const setAudioTrack = useCallback(
    (i: number) =>
      safeMethod(videoRef.current?.setAudioTrack, "setAudioTrack")(i),
    [videoRef],
  );
  const setSubtitleTrack = useCallback(
    (i: number) =>
      safeMethod(videoRef.current?.setSubtitleTrack, "setSubtitleTrack")(i),
    [videoRef],
  );
  const setSubtitleURL = useCallback(
    (url: string, n: string) =>
      safeMethod(videoRef.current?.setSubtitleURL, "setSubtitleURL")(url, n),
    [videoRef],
  );

  /* ---------- memory / cache cleanup ---------- */
  useEffect(() => {
    const interval = setInterval(() => {
      if (!videoState.isPlaying) videoRef.current?.clearCache?.();
    }, 60000); // every minute
    return () => {
      clearInterval(interval);
      videoRef.current?.dispose?.();
    };
  }, [videoState.isPlaying]);

  /* ---------- render guard ---------- */

  if (itemStatus.isError || streamStatus.isError) {
    return (
      <View className='w-screen h-screen items-center justify-center bg-black'>
        <Text className='text-white'>{t("player.error")}</Text>
      </View>
    );
  }

  if (itemStatus.isLoading || streamStatus.isLoading || !item || !stream) {
    return (
      <View className='w-screen h-screen items-center justify-center bg-black'>
        <Loader />
      </View>
    );
  }

  /* ---------- render ---------- */
  return (
    <View style={{ flex: 1, backgroundColor: "black" }}>
      <View
        style={{
          width: "100%",
          height: "100%",
          paddingLeft: ignoreSafeAreas ? 0 : insets.left,
          paddingRight: ignoreSafeAreas ? 0 : insets.right,
        }}
      >
        <VlcPlayerView
          ref={videoRef}
          source={{
            uri: stream.url,
            autoplay: true,
            isNetwork: true,
            startPosition,
            externalSubtitles,
            initOptions: optimizedInitOptions,
          }}
          style={{ width: "100%", height: "100%" }}
          onVideoProgress={onProgress}
          progressUpdateInterval={1000}
          onVideoStateChange={onPlaybackStateChanged}
          onPipStarted={onPipStarted}
          onVideoLoadEnd={() => dispatch({ type: "VIDEO_LOADED" })}
          onVideoError={(e) => {
            console.error("Video Error:", e.nativeEvent);
            Alert.alert(
              t("player.error"),
              t("player.an_error_occured_while_playing_the_video"),
            );
            writeToLog("ERROR", "Video Error", e.nativeEvent);
          }}
        />
      </View>

      {!videoState.isPipStarted && (
        <Controls
          mediaSource={stream.mediaSource}
          item={item}
          videoRef={videoRef}
          togglePlay={togglePlay}
          isPlaying={videoState.isPlaying}
          isSeeking={isSeeking}
          progress={progress}
          cacheProgress={cacheProgress}
          isBuffering={videoState.isBuffering}
          showControls={showControls}
          setShowControls={setShowControls}
          setIgnoreSafeAreas={setIgnoreSafeAreas}
          ignoreSafeAreas={ignoreSafeAreas}
          isVideoLoaded={videoState.isVideoLoaded}
          startPictureInPicture={startPictureInPicture}
          play={play}
          pause={pause}
          seek={seek}
          enableTrickplay
          getAudioTracks={getAudioTracks}
          getSubtitleTracks={getSubtitleTracks}
          offline={offline}
          setSubtitleTrack={setSubtitleTrack}
          setSubtitleURL={setSubtitleURL}
          setAudioTrack={setAudioTrack}
          isVlc
        />
      )}
    </View>
  );
}
