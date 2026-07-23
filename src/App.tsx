import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Store } from "@tauri-apps/plugin-store";
import {
  hideAppWindow,
  initPlatformWindow,
  isMacosPlatform,
  isWindowsPlatform,
} from "./platform/window";
import "./App.css";

type TabId = "convert" | "preferences";
type DestinationId = "local" | "businessmap";
type QueueStatus = "pending" | "converting" | "uploading" | "done" | "error";
type VideoOutputFormat = "gif" | "mov" | "mp4" | "webm";

type QueueItem = {
  path: string;
  name: string;
  status: QueueStatus;
  error?: string;
  outputPath?: string;
  filePercent?: number;
  outputFormat?: VideoOutputFormat;
};

type FfmpegStatus = {
  available: boolean;
  message: string;
};

type FfmpegConfig = {
  fps: number;
  width: number;
  maxColors: number;
};

type ConvertBatchFinished = {
  ok: number;
  failed: number;
  destination: DestinationId;
  cardId?: number | null;
  cardUrl?: string | null;
  commentError?: string | null;
  cancelled?: boolean;
  skipped?: number;
};

type ConvertFileUploading = {
  index: number;
  total: number;
  name: string;
  path: string;
};

type ConvertProgressState = {
  active: boolean;
  current: number;
  total: number;
  fileName: string;
  filePercent: number;
};

type ConvertBatchStarted = { total: number };
type ConvertFileStarted = {
  index: number;
  total: number;
  name: string;
  path: string;
};
type ConvertProgressEvent = {
  index: number;
  total: number;
  name: string;
  path: string;
  filePercent: number;
};
type ConvertFileFinished = {
  index: number;
  total: number;
  name: string;
  path: string;
  ok: boolean;
  error?: string | null;
  outputPath?: string | null;
};

const STORE_FILE = "settings.json";
const OUTPUT_DIR_KEY = "outputDir";
const FFMPEG_FPS_KEY = "ffmpegFps";
const FFMPEG_WIDTH_KEY = "ffmpegWidth";
const FFMPEG_MAX_COLORS_KEY = "ffmpegMaxColors";
const BM_API_KEY = "businessmapApiKey";
const BM_BASE_URL_KEY = "businessmapBaseUrl";
const BM_BOARD_ID_KEY = "businessmapBoardId";
const BM_COMMENT_TEMPLATE_KEY = "businessmapCommentTemplate";
const DEFAULT_BM_BASE_URL = "https://dasa.businessmap.io";
const DEFAULT_BM_COMMENT_TEMPLATE = "{filename}";
const VIDEO_EXT = /\.(mov|mp4)$/i;
const IMAGE_EXT = /\.(jpe?g|png)$/i;
const CARD_ID_PATTERN = /(?:^|\/)cards\/(\d+)/i;
const BOARD_ID_PATTERN = /(?:^|\/)ctrl_board\/(\d+)/i;

function normalizeCardPathInput(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return null;
    }
  }

  value = value.replace(/^[^/]*businessmap\.io\/?/i, "");
  value = value.replace(/^\/+/, "").replace(/\/+$/, "");
  value = value.replace(/\/comments(\/.*)?$/i, "");

  const cardMatch = value.match(CARD_ID_PATTERN);
  if (!cardMatch) return null;

  const cardId = cardMatch[1];
  const boardMatch = value.match(BOARD_ID_PATTERN);

  if (boardMatch) {
    return `ctrl_board/${boardMatch[1]}/cards/${cardId}/`;
  }

  return `cards/${cardId}/`;
}

function parseCardIdFromPath(path: string): number | null {
  const match = path.trim().match(CARD_ID_PATTERN);
  if (!match) return null;
  const id = Number.parseInt(match[1], 10);
  return Number.isNaN(id) ? null : id;
}

function parseBoardIdFromPath(path: string): number | null {
  const match = path.trim().match(BOARD_ID_PATTERN);
  if (!match) return null;
  const id = Number.parseInt(match[1], 10);
  return Number.isNaN(id) ? null : id;
}

function isCompleteCardPath(path: string): boolean {
  return parseBoardIdFromPath(path) !== null && parseCardIdFromPath(path) !== null;
}

function buildCardPath(boardId: string, cardId: string): string | null {
  const board = boardId.trim();
  const card = cardId.trim();
  if (!board || !card || !/^\d+$/.test(board) || !/^\d+$/.test(card)) {
    return null;
  }
  return `ctrl_board/${board}/cards/${card}/`;
}

function parsePastedCardPath(raw: string): { boardId: string; cardId: string } | null {
  const normalized = normalizeCardPathInput(raw);
  if (!normalized || !isCompleteCardPath(normalized)) return null;
  const board = parseBoardIdFromPath(normalized);
  const card = parseCardIdFromPath(normalized);
  if (board === null || card === null) return null;
  return { boardId: String(board), cardId: String(card) };
}

function sanitizeIdInput(raw: string): string {
  return raw.replace(/\D/g, "");
}

function buildCardPageUrl(baseUrl: string, boardId: string, cardId: string): string | null {
  const cardPath = buildCardPath(boardId, cardId);
  if (!cardPath) return null;
  return `${baseUrl.replace(/\/+$/, "")}/${cardPath.replace(/\/+$/, "")}/`;
}

function buildCardCommentsPageUrl(baseUrl: string, cardPath: string): string {
  const normalized = normalizeCardPathInput(cardPath);
  if (!normalized || !isCompleteCardPath(normalized)) {
    return baseUrl.replace(/\/+$/, "");
  }
  return `${baseUrl.replace(/\/+$/, "")}/${normalized.replace(/\/+$/, "")}/comments`;
}

const DEFAULT_FFMPEG_CONFIG: FfmpegConfig = {
  fps: 10,
  width: 480,
  maxColors: 128,
};

function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function isVideoPath(path: string): boolean {
  return VIDEO_EXT.test(path);
}

function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path);
}

function isAcceptedPath(path: string, destination: DestinationId): boolean {
  if (isVideoPath(path)) return true;
  return destination === "businessmap" && isImagePath(path);
}

function acceptedFormatsLabel(destination: DestinationId): string {
  return destination === "businessmap"
    ? ".mov, .mp4, .jpg, or .png"
    : ".mov or .mp4";
}

function buildGifFilterPreview(config: FfmpegConfig): string {
  return `fps=${config.fps},scale=${config.width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${config.maxColors}[p];[s1][p]paletteuse`;
}

function clampConfig(config: FfmpegConfig): FfmpegConfig {
  return {
    fps: Math.min(30, Math.max(1, Math.round(config.fps))),
    width: Math.max(1, Math.round(config.width)),
    maxColors: Math.min(256, Math.max(2, Math.round(config.maxColors))),
  };
}

function overallPercent(progress: ConvertProgressState): number {
  if (progress.total === 0) return 0;
  const completed = progress.current + progress.filePercent / 100;
  return Math.min(100, (completed / progress.total) * 100);
}

type ConvertButtonContext = {
  converting: boolean;
  destination: DestinationId;
  pendingCount: number;
  imagesOnly: boolean;
};

const CONVERT_BUTTON_LABELS = {
  local: {
    idle: "Convert",
    ready: (count: number) => `Convert ${count}`,
    busy: "Converting…",
  },
  businessmap: {
    mixed: {
      idle: "Convert & post",
      ready: (count: number) => `Convert & post ${count}`,
      busy: "Converting & posting…",
    },
    imagesOnly: {
      idle: "Post",
      ready: (count: number) => `Post ${count}`,
      busy: "Posting…",
    },
  },
} as const;

function getConvertButtonLabel({
  converting,
  destination,
  pendingCount,
  imagesOnly,
}: ConvertButtonContext): string {
  const phase = converting ? "busy" : pendingCount > 0 ? "ready" : "idle";

  if (destination === "local") {
    const labels = CONVERT_BUTTON_LABELS.local;
    if (phase === "ready") return labels.ready(pendingCount);
    return labels[phase];
  }

  const labels = imagesOnly
    ? CONVERT_BUTTON_LABELS.businessmap.imagesOnly
    : CONVERT_BUTTON_LABELS.businessmap.mixed;
  if (phase === "ready") return labels.ready(pendingCount);
  return labels[phase];
}

function getQueueStatusLabel(item: QueueItem): string {
  if (item.status === "converting" && item.filePercent != null) {
    return `${Math.round(item.filePercent)}%`;
  }
  if (item.status === "uploading") return "post";
  return item.status;
}

function canRemoveQueueItem(item: QueueItem, converting: boolean): boolean {
  return (
    !converting &&
    item.status !== "converting" &&
    item.status !== "uploading"
  );
}

function isQueueItemFormatEditable(item: QueueItem): boolean {
  return isVideoPath(item.path) && (item.status === "pending" || item.status === "error");
}

function shouldShowQueueStatusBadge(item: QueueItem): boolean {
  return item.status !== "pending";
}

function App() {
  const [activeTab, setActiveTab] = useState<TabId>("convert");
  const [outputDir, setOutputDir] = useState<string>("");
  const [ffmpegConfig, setFfmpegConfig] = useState<FfmpegConfig>(DEFAULT_FFMPEG_CONFIG);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState<ConvertProgressState | null>(null);
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [store, setStore] = useState<Store | null>(null);
  const [isMacos] = useState(isMacosPlatform);
  const [isWindows] = useState(isWindowsPlatform);
  const [destination, setDestination] = useState<DestinationId>("local");
  const [boardId, setBoardId] = useState("");
  const [cardId, setCardId] = useState("");
  const [bmApiKey, setBmApiKey] = useState("");
  const [bmBaseUrl, setBmBaseUrl] = useState(DEFAULT_BM_BASE_URL);
  const [bmCommentTemplate, setBmCommentTemplate] = useState(DEFAULT_BM_COMMENT_TEMPLATE);
  const [bmTestMessage, setBmTestMessage] = useState<string | null>(null);
  const [bmTesting, setBmTesting] = useState(false);
  const [lastCardLink, setLastCardLink] = useState<string | null>(null);

  const filterPreview = useMemo(
    () => buildGifFilterPreview(ffmpegConfig),
    [ffmpegConfig],
  );

  const dropzoneHint = useMemo(() => {
    const formats =
      destination === "businessmap"
        ? ".mov, .mp4, .jpg, .png"
        : ".mov and .mp4";
    return `${formats} · fps ${ffmpegConfig.fps} · width ${ffmpegConfig.width} · ${ffmpegConfig.maxColors} colors`;
  }, [destination, ffmpegConfig]);

  useEffect(() => {
    initPlatformWindow().catch(console.error);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const [ffmpegStatus, settings] = await Promise.all([
        invoke<FfmpegStatus>("check_ffmpeg"),
        Store.load(STORE_FILE),
      ]);
      if (cancelled) return;

      setFfmpeg(ffmpegStatus);
      setStore(settings);

      const savedOutputDir = await settings.get<string>(OUTPUT_DIR_KEY);
      if (savedOutputDir) setOutputDir(savedOutputDir);

      const savedFps = await settings.get<number>(FFMPEG_FPS_KEY);
      const savedWidth = await settings.get<number>(FFMPEG_WIDTH_KEY);
      const savedMaxColors = await settings.get<number>(FFMPEG_MAX_COLORS_KEY);

      setFfmpegConfig(
        clampConfig({
          fps: savedFps ?? DEFAULT_FFMPEG_CONFIG.fps,
          width: savedWidth ?? DEFAULT_FFMPEG_CONFIG.width,
          maxColors: savedMaxColors ?? DEFAULT_FFMPEG_CONFIG.maxColors,
        }),
      );

      const savedBmApiKey = await settings.get<string>(BM_API_KEY);
      const savedBmBaseUrl = await settings.get<string>(BM_BASE_URL_KEY);
      const savedBmBoardId = await settings.get<string>(BM_BOARD_ID_KEY);
      const savedBmTemplate = await settings.get<string>(BM_COMMENT_TEMPLATE_KEY);
      if (savedBmApiKey) setBmApiKey(savedBmApiKey);
      if (savedBmBaseUrl) setBmBaseUrl(savedBmBaseUrl);
      if (savedBmBoardId) setBoardId(savedBmBoardId);
      if (savedBmTemplate) setBmCommentTemplate(savedBmTemplate);
    }

    init().catch((err) => {
      console.error(err);
      setNotice(String(err));
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    async function setupListeners() {
      unlisteners.push(
        await listen<ConvertBatchStarted>("convert-batch-started", (event) => {
          setProgress({
            active: true,
            current: 0,
            total: event.payload.total,
            fileName: "",
            filePercent: 0,
          });
        }),
      );

      unlisteners.push(
        await listen<ConvertFileStarted>("convert-file-started", (event) => {
          const { index, total, name, path } = event.payload;
          setProgress({
            active: true,
            current: index,
            total,
            fileName: name,
            filePercent: 0,
          });
          setQueue((prev) =>
            prev.map((item) =>
              item.path === path
                ? {
                    ...item,
                    status: "converting",
                    error: undefined,
                    outputPath: undefined,
                    filePercent: 0,
                  }
                : item,
            ),
          );
        }),
      );

      unlisteners.push(
        await listen<ConvertProgressEvent>("convert-progress", (event) => {
          const { index, total, name, path, filePercent } = event.payload;
          setProgress({
            active: true,
            current: index,
            total,
            fileName: name,
            filePercent,
          });
          setQueue((prev) =>
            prev.map((item) =>
              item.path === path ? { ...item, filePercent } : item,
            ),
          );
        }),
      );

      unlisteners.push(
        await listen<ConvertFileUploading>("convert-file-uploading", (event) => {
          const { path } = event.payload;
          setQueue((prev) =>
            prev.map((item) =>
              item.path === path
                ? { ...item, status: "uploading", filePercent: undefined }
                : item,
            ),
          );
        }),
      );

      unlisteners.push(
        await listen<ConvertFileFinished>("convert-file-finished", (event) => {
          const { path, ok, error, outputPath } = event.payload;
          setQueue((prev) =>
            prev.map((item) => {
              if (item.path !== path) return item;
              if (ok) {
                return {
                  ...item,
                  status: "done",
                  error: undefined,
                  outputPath: outputPath ?? undefined,
                  filePercent: 100,
                };
              }
              return {
                ...item,
                status: "error",
                error: error ?? "Conversion failed",
                outputPath: undefined,
                filePercent: undefined,
              };
            }),
          );
        }),
      );

      unlisteners.push(
        await listen<ConvertBatchFinished>("convert-batch-finished", (event) => {
          const {
            ok,
            failed,
            destination: dest,
            cardUrl: finishedCardUrl,
            commentError,
            cancelled,
            skipped = 0,
          } = event.payload;
          setConverting(false);
          setProgress(null);
          setCardId("");

          if (cancelled) {
            if (dest === "businessmap") {
              if (commentError) {
                setNotice(
                  `Cancelled. Posted comment with ${ok} uploaded file${ok === 1 ? "" : "s"}, but comment failed: ${commentError}`,
                );
              } else if (ok > 0) {
                setNotice(
                  `Cancelled. Posted comment with ${ok} uploaded file${ok === 1 ? "" : "s"}.`,
                );
              } else {
                setNotice(
                  skipped > 0
                    ? `Cancelled before any files were posted. ${skipped} file${skipped === 1 ? "" : "s"} remaining.`
                    : "Cancelled.",
                );
              }
              if (finishedCardUrl) {
                setLastCardLink(buildCardCommentsPageUrl(bmBaseUrl, finishedCardUrl));
              }
            } else {
              setNotice(
                skipped > 0
                  ? `Cancelled after converting ${ok} file${ok === 1 ? "" : "s"}. ${skipped} remaining.`
                  : `Cancelled after converting ${ok} file${ok === 1 ? "" : "s"}.`,
              );
            }
            return;
          }

          if (dest === "businessmap") {
            if (commentError) {
              setNotice(
                failed === 0
                  ? `Uploaded ${ok} file${ok === 1 ? "" : "s"}, but comment failed: ${commentError}`
                  : `Uploaded ${ok}, failed ${failed}. Comment failed: ${commentError}`,
              );
            } else if (failed === 0) {
              setNotice(`Posted ${ok} file${ok === 1 ? "" : "s"} to BusinessMap.`);
            } else {
              setNotice(`Posted ${ok}, failed ${failed} on BusinessMap.`);
            }
            if (finishedCardUrl) {
              setLastCardLink(buildCardCommentsPageUrl(bmBaseUrl, finishedCardUrl));
            }
          } else {
            setNotice(
              failed === 0
                ? `Converted ${ok} file${ok === 1 ? "" : "s"}.`
                : `Converted ${ok}, failed ${failed}.`,
            );
          }
        }),
      );
    }

    setupListeners().catch(console.error);

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [bmBaseUrl]);

  const addPaths = useCallback(
    (paths: string[]) => {
      if (converting) return;

      const accepted = paths.filter((path) => isAcceptedPath(path, destination));
      const skipped = paths.length - accepted.length;

      if (skipped > 0) {
        setNotice(
          skipped === 1
            ? `Skipped 1 unsupported file (${acceptedFormatsLabel(destination)}).`
            : `Skipped ${skipped} unsupported files (${acceptedFormatsLabel(destination)}).`,
        );
      } else {
        setNotice(null);
      }

      if (accepted.length === 0) return;

      setQueue((prev) => {
        const existing = new Set(prev.map((item) => item.path));
        const next = accepted
          .filter((path) => !existing.has(path))
          .map((path) => ({
            path,
            name: fileName(path),
            status: "pending" as const,
            ...(isVideoPath(path) ? { outputFormat: "gif" as const } : {}),
          }));
        return next.length ? [...prev, ...next] : prev;
      });
    },
    [destination, converting],
  );

  useEffect(() => {
    if (destination !== "local") return;

    setQueue((prev) => {
      const images = prev.filter((item) => isImagePath(item.path));
      if (images.length === 0) return prev;
      setNotice(
        images.length === 1
          ? "Removed 1 image from queue (images only post to BusinessMap)."
          : `Removed ${images.length} images from queue (images only post to BusinessMap).`,
      );
      return prev.filter((item) => !isImagePath(item.path));
    });
  }, [destination]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setDropActive(true);
        } else if (event.payload.type === "drop") {
          setDropActive(false);
          addPaths(event.payload.paths);
        } else {
          setDropActive(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(console.error);

    return () => {
      unlisten?.();
    };
  }, [addPaths]);

  const persistOutputDir = useCallback(
    async (dir: string) => {
      setOutputDir(dir);
      if (!store) return;
      await store.set(OUTPUT_DIR_KEY, dir);
      await store.save();
    },
    [store],
  );

  const persistFfmpegConfig = useCallback(
    async (config: FfmpegConfig) => {
      const next = clampConfig(config);
      setFfmpegConfig(next);
      if (!store) return;
      await store.set(FFMPEG_FPS_KEY, next.fps);
      await store.set(FFMPEG_WIDTH_KEY, next.width);
      await store.set(FFMPEG_MAX_COLORS_KEY, next.maxColors);
      await store.save();
    },
    [store],
  );

  const persistBoardId = useCallback(
    async (id: string) => {
      setBoardId(id);
      if (!store) return;
      await store.set(BM_BOARD_ID_KEY, id);
      await store.save();
    },
    [store],
  );

  const persistBmSettings = useCallback(
    async (next: {
      apiKey?: string;
      baseUrl?: string;
      commentTemplate?: string;
    }) => {
      if (!store) return;
      if (next.apiKey !== undefined) {
        setBmApiKey(next.apiKey);
        await store.set(BM_API_KEY, next.apiKey);
      }
      if (next.baseUrl !== undefined) {
        setBmBaseUrl(next.baseUrl);
        await store.set(BM_BASE_URL_KEY, next.baseUrl);
      }
      if (next.commentTemplate !== undefined) {
        setBmCommentTemplate(next.commentTemplate);
        await store.set(BM_COMMENT_TEMPLATE_KEY, next.commentTemplate);
      }
      await store.save();
    },
    [store],
  );

  async function testBusinessmapConnection() {
    if (!bmApiKey.trim()) {
      setBmTestMessage("Add your API key first.");
      return;
    }
    setBmTesting(true);
    setBmTestMessage(null);
    try {
      const username = await invoke<string>("test_businessmap_connection", {
        baseUrl: bmBaseUrl.trim() || DEFAULT_BM_BASE_URL,
        apiKey: bmApiKey.trim(),
      });
      setBmTestMessage(`Connected as ${username}.`);
    } catch (err) {
      setBmTestMessage(String(err));
    } finally {
      setBmTesting(false);
    }
  }

  async function chooseOutputDir() {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: outputDir || undefined,
    });
    if (typeof selected === "string") {
      await persistOutputDir(selected);
    }
  }

  async function addFiles() {
    if (converting) return;

    const selected = await open({
      multiple: true,
      filters: [
        destination === "businessmap"
          ? {
              name: "Evidence",
              extensions: ["mov", "mp4", "jpg", "jpeg", "png"],
            }
          : { name: "Video", extensions: ["mov", "mp4"] },
      ],
    });
    if (selected == null) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    addPaths(paths);
  }

  function clearQueue() {
    setQueue((prev) => {
      if (converting) {
        return prev.filter(
          (item) => item.status === "converting" || item.status === "uploading",
        );
      }
      return [];
    });
    if (!converting) setNotice(null);
  }

  function removeItem(path: string) {
    setQueue((prev) => {
      const item = prev.find((entry) => entry.path === path);
      if (!item || item.status === "converting" || item.status === "uploading") return prev;
      return prev.filter((entry) => entry.path !== path);
    });
  }

  function resetPreferences() {
    void persistFfmpegConfig(DEFAULT_FFMPEG_CONFIG);
  }

  function updateConfigField(field: keyof FfmpegConfig, rawValue: string) {
    const parsed = Number.parseInt(rawValue, 10);
    if (Number.isNaN(parsed)) return;
    void persistFfmpegConfig({ ...ffmpegConfig, [field]: parsed });
  }

  const pendingItems = useMemo(
    () => queue.filter((item) => item.status === "pending" || item.status === "error"),
    [queue],
  );

  const pendingCount = pendingItems.length;

  const pendingHasVideos = useMemo(
    () => pendingItems.some((item) => isVideoPath(item.path)),
    [pendingItems],
  );

  const pendingHasImagesOnly = pendingCount > 0 && !pendingHasVideos;

  const doneCount = useMemo(
    () => queue.filter((item) => item.status === "done").length,
    [queue],
  );

  function updateItemOutputFormat(path: string, outputFormat: VideoOutputFormat) {
    setQueue((prev) =>
      prev.map((item) =>
        item.path === path ? { ...item, outputFormat } : item,
      ),
    );
  }

  function handleBoardInput(raw: string) {
    const parsed = parsePastedCardPath(raw);
    if (parsed) {
      void persistBoardId(parsed.boardId);
      setCardId(parsed.cardId);
      return;
    }
    void persistBoardId(sanitizeIdInput(raw));
  }

  function handleCardInput(raw: string) {
    const parsed = parsePastedCardPath(raw);
    if (parsed) {
      void persistBoardId(parsed.boardId);
      setCardId(parsed.cardId);
      return;
    }
    setCardId(sanitizeIdInput(raw));
  }

  const cardPath = useMemo(
    () => buildCardPath(boardId, cardId),
    [boardId, cardId],
  );

  const cardPreviewUrl = useMemo(
    () => buildCardPageUrl(bmBaseUrl.trim() || DEFAULT_BM_BASE_URL, boardId, cardId),
    [bmBaseUrl, boardId, cardId],
  );

  async function cancelBatch() {
    try {
      await invoke("cancel_convert_batch");
    } catch (err) {
      setNotice(String(err));
    }
  }

  async function convert() {
    if (converting) return;

    if (pendingHasVideos && !ffmpeg?.available) {
      setNotice(ffmpeg?.message ?? "ffmpeg is not available.");
      return;
    }

    if (destination === "local" && !outputDir) {
      setNotice("Choose an output folder first.");
      return;
    }

    if (destination === "businessmap") {
      if (!cardPath) {
        setNotice("Enter board and card IDs, e.g. board 99 and card 402794.");
        return;
      }
      if (!bmApiKey.trim()) {
        setNotice("Add your BusinessMap API key in Preferences.");
        return;
      }
    }

    const toConvert = pendingItems;
    if (toConvert.length === 0) {
      setNotice(`Add at least one supported file (${acceptedFormatsLabel(destination)}).`);
      return;
    }

    setConverting(true);
    setNotice(null);
    setLastCardLink(null);
    setProgress({
      active: true,
      current: 0,
      total: toConvert.length,
      fileName: "",
      filePercent: 0,
    });

    try {
      const normalizedCardPath =
        destination === "businessmap" ? cardPath : null;

      await invoke("convert_videos", {
        items: toConvert.map((item) => ({
          path: item.path,
          outputFormat: item.outputFormat ?? "gif",
        })),
        outputDir: destination === "local" ? outputDir : null,
        destination,
        businessmap:
          destination === "businessmap" && normalizedCardPath
            ? {
                cardUrl: normalizedCardPath,
                apiKey: bmApiKey.trim(),
                baseUrl: bmBaseUrl.trim() || DEFAULT_BM_BASE_URL,
                commentTemplate: bmCommentTemplate.trim() || DEFAULT_BM_COMMENT_TEMPLATE,
              }
            : null,
        config: clampConfig(ffmpegConfig),
      });
    } catch (err) {
      setConverting(false);
      setProgress(null);
      setNotice(String(err));
    }
  }

  const missingBoardId =
    destination === "businessmap" && boardId.trim().length === 0;
  const missingCardId =
    destination === "businessmap" && cardId.trim().length === 0;
  const showCardTargetHint =
    destination === "businessmap" &&
    pendingCount > 0 &&
    !converting &&
    (missingBoardId || missingCardId);

  const convertBlockedReason = useMemo(() => {
    if (converting || pendingCount === 0) return null;
    if (pendingHasVideos && !ffmpeg?.available) {
      return ffmpeg?.message ?? "ffmpeg is not available.";
    }
    if (destination === "local" && !outputDir) {
      return "Choose an output folder first.";
    }
    if (destination === "businessmap") {
      if (missingBoardId && missingCardId) {
        return "Enter board and card IDs to post.";
      }
      if (missingBoardId) return "Enter board ID to post.";
      if (missingCardId) return "Enter card ID to post.";
      if (!bmApiKey.trim()) {
        return "Add your BusinessMap API key in Preferences.";
      }
    }
    return null;
  }, [
    converting,
    pendingCount,
    pendingHasVideos,
    ffmpeg,
    destination,
    outputDir,
    missingBoardId,
    missingCardId,
    bmApiKey,
  ]);

  const canConvert =
    pendingCount > 0 &&
    !converting &&
    (!pendingHasVideos || ffmpeg?.available) &&
    (destination === "local"
      ? Boolean(outputDir)
      : Boolean(cardPath && bmApiKey.trim()));

  const progressPercent = progress ? overallPercent(progress) : 0;
  const businessmapProcessing =
    converting && destination === "businessmap" && progress?.active === true;
  const convertLockedClass = businessmapProcessing ? " convert-locked" : "";

  const convertButtonLabel = getConvertButtonLabel({
    converting,
    destination,
    pendingCount,
    imagesOnly: pendingHasImagesOnly,
  });

  const progressPanel = progress?.active ? (
    <section className="progress-panel" aria-live="polite">
      <div className="progress-header">
        <span className="progress-label">
          {progress.fileName
            ? destination === "businessmap"
              ? `Processing ${progress.current + 1} of ${progress.total}: ${progress.fileName}`
              : `Converting ${progress.current + 1} of ${progress.total}: ${progress.fileName}`
            : `Preparing ${progress.total} file${progress.total === 1 ? "" : "s"}…`}
        </span>
        <div className="progress-header-actions">
          <span className="progress-percent">{Math.round(progressPercent)}%</span>
          {converting && (
            <button
              type="button"
              className="secondary progress-cancel"
              onClick={cancelBatch}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      <div
        className="progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progressPercent)}
      >
        <div
          className="progress-bar-fill"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
    </section>
  ) : null;

  return (
    <main className={`app${isMacos ? " app-macos" : ""}${isWindows ? " app-windows" : ""}`}>
      {isMacos && (
        <div className="macos-chrome" data-tauri-drag-region>
        <header className="header">
        <h1 className="macos-title">Evidence GIF Converter</h1>
        <p className="subtitle">
          Drop .mov / .mp4 evidence videos → GIFs
        </p>
      </header>
          <button
            type="button"
            className="macos-close"
            aria-label="Close panel"
            onClick={() => {
              hideAppWindow().catch(console.error);
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" 
              width="24" 
              height="24"
              fill="currentColor"><path d="M11.9997 10.5865L16.9495 5.63672L18.3637 7.05093L13.4139 12.0007L18.3637 16.9504L16.9495 18.3646L11.9997 13.4149L7.04996 18.3646L5.63574 16.9504L10.5855 12.0007L5.63574 7.05093L7.04996 5.63672L11.9997 10.5865Z"></path></svg>
          </button>
        </div>
        
      )}

      {isWindows && (
        <div className="windows-chrome" data-tauri-drag-region>
          <header className="header">
            <h1 className="windows-title">Evidence GIF Converter</h1>
            <p className="subtitle">Drop .mov / .mp4 evidence videos → GIFs</p>
          </header>
          <button
            type="button"
            className="windows-close"
            aria-label="Close window"
            onClick={() => {
              hideAppWindow().catch(console.error);
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2 2 10 10M10 2 2 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
            </svg>
          </button>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Main sections">
        <button
          type="button"
          role="tab"
          className={`tab ${activeTab === "convert" ? "tab-active" : ""}`}
          aria-selected={activeTab === "convert"}
          onClick={() => setActiveTab("convert")}
        >
          Convert 
        </button>
        <button
          type="button"
          role="tab"
          className={`tab ${activeTab === "preferences" ? "tab-active" : ""}`}
          aria-selected={activeTab === "preferences"}
          onClick={() => setActiveTab("preferences")}
        >
          Preferences
        </button>
      </div>

      {ffmpeg && !ffmpeg.available && pendingHasVideos && (
        <div className="banner banner-error" role="alert">
          {ffmpeg.message}
        </div>
      )}
      {activeTab === "convert" && (
        <div className="tab-panel tab-panel-convert" role="tabpanel">
          <section className={`destination-row${convertLockedClass}`}>
              <span className="label">Destination</span>
              <div className="destination-options" role="radiogroup" aria-label="Output destination">
                <label className="destination-option">
                  <input
                    type="radio"
                    name="destination"
                    value="local"
                    checked={destination === "local"}
                    disabled={converting}
                    onChange={() => setDestination("local")}
                  />
                  Save locally
                </label>
                <label className="destination-option">
                  <input
                    type="radio"
                    name="destination"
                    value="businessmap"
                    checked={destination === "businessmap"}
                    disabled={converting}
                    onChange={() => setDestination("businessmap")}
                  />
                  Post to BusinessMap
                </label>
              </div>
            </section>

            {destination === "local" ? (
              <section className={`dir-row${convertLockedClass}`}>
                <div className="dir-info">
                  <span className="label">Save to</span>
                  <span className="dir-path" title={outputDir || undefined}>
                    {outputDir || "No folder selected"}
                  </span>
                </div>
                <button type="button" onClick={chooseOutputDir} disabled={converting}>
                  Change…
                </button>
              </section>
            ) : (
              <section
                className={`card-url-row${showCardTargetHint ? " card-url-row-attention" : ""}${convertLockedClass}`}
                aria-describedby={showCardTargetHint ? "card-target-hint" : undefined}
              >
                <div className="card-url-field">
                  <div
                    className={`card-url-combo card-url-combo-board${showCardTargetHint && missingBoardId ? " field-missing" : ""}`}
                  >
                    <label htmlFor="board-input" className="card-url-prefix">Board</label>
                    <input
                      id="board-input"
                      type="text"
                      inputMode="numeric"
                      className="card-url-input card-url-input-board"
                      placeholder="99"
                      value={boardId}
                      disabled={converting}
                      aria-invalid={showCardTargetHint && missingBoardId}
                      onChange={(event) => handleBoardInput(event.target.value)}
                    />
                  </div>
                  <div
                    className={`card-url-combo card-url-combo-card${showCardTargetHint && missingCardId ? " field-missing" : ""}`}
                  >
                    <label htmlFor="card-input" className="card-url-prefix">Card</label>
                    <input
                      id="card-input"
                      type="text"
                      inputMode="numeric"
                      className="card-url-input card-url-input-card"
                      placeholder="402794"
                      value={cardId}
                      disabled={converting}
                      aria-invalid={showCardTargetHint && missingCardId}
                      onChange={(event) => handleCardInput(event.target.value)}
                    />
                  </div>
                </div>
                {showCardTargetHint ? (
                  <p className="field-hint field-hint-error" id="card-target-hint" role="status">
                    {missingBoardId && missingCardId
                      ? "Board and card IDs are required to post."
                      : missingBoardId
                        ? "Board ID is required to post."
                        : "Card ID is required to post."}
                  </p>
                ) : cardPreviewUrl ? (
                  <button
                    type="button"
                    className="linkish card-url-preview"
                    title="Open card in browser"
                    onClick={() => {
                      openUrl(cardPreviewUrl).catch(console.error);
                    }}
                  >
                    {cardPreviewUrl}
                  </button>
                ) : (
                  <span className="pref-hint">
                    Enter board and card IDs to preview the card URL.
                  </span>
                )}
              </section>
            )}

            <section
              className={`dropzone ${dropActive ? "dropzone-active" : ""}${convertLockedClass}`}
              aria-label={
                destination === "businessmap"
                  ? "Drop video or image files here"
                  : "Drop video files here"
              }
            >
              <p className="dropzone-title">
                {destination === "businessmap"
                  ? "Drag & drop videos or images here"
                  : "Drag & drop videos here"}
              </p>
              <p className="dropzone-hint">{dropzoneHint}</p>
              <button type="button" className="secondary" onClick={addFiles} disabled={converting}>
                Add files…
              </button>
            </section>

            {notice && <p className={`notice${convertLockedClass}`}>{notice}</p>}

            {lastCardLink && (
              <p className={`notice notice-ok${convertLockedClass}`}>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    openUrl(lastCardLink).catch(console.error);
                  }}
                >
                  Open card comments in browser
                </button>
              </p>
            )}

            {progressPanel}

            <section className={`queue`}>
              <div className="queue-header">
                <h2>
                  Queue{" "}
                  <span className="count">
                    {queue.length === 0
                      ? "empty"
                      : `${doneCount}/${queue.length} done`}
                  </span>
                </h2>
                <button
                  type="button"
                  className="secondary"
                  onClick={clearQueue}
                  disabled={queue.length === 0 || converting}
                >
                  Clear
                </button>
              </div>

              {queue.length === 0 ? (
                <p className="empty">No files yet.</p>
              ) : (
                <ul className="queue-list">
                  {queue.map((item) => (
                    <li key={item.path} className={`queue-item status-${item.status}`}>
                      <div className="queue-item-header">
                        <span className="queue-name" title={item.path}>
                          {item.name}
                        </span>
                        <div className="queue-item-toolbar">
                          {isQueueItemFormatEditable(item) && (
                            <select
                              className="queue-format-select"
                              aria-label={`Output format for ${item.name}`}
                              value={item.outputFormat ?? "gif"}
                              disabled={converting}
                              onChange={(event) => {
                                updateItemOutputFormat(
                                  item.path,
                                  event.target.value as VideoOutputFormat,
                                );
                              }}
                            >
                              <option value="gif">GIF</option>
                              <option value="mov">MOV</option>
                              <option value="mp4">MP4</option>
                              <option value="webm">WEBM</option>
                            </select>
                          )}
                          {shouldShowQueueStatusBadge(item) && (
                            <span className={`queue-status-badge status-${item.status}`}>
                              {getQueueStatusLabel(item)}
                            </span>
                          )}
                          {canRemoveQueueItem(item, converting) && (
                            <button
                              type="button"
                              className="queue-remove"
                              aria-label={`Remove ${item.name}`}
                              onClick={() => removeItem(item.path)}
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                width="14"
                                height="14"
                                fill="currentColor"
                                aria-hidden="true"
                              >
                                <path d="M11.9997 10.5865L16.9495 5.63672L18.3637 7.05093L13.4139 12.0007L18.3637 16.9504L16.9495 18.3646L11.9997 13.4149L7.04996 18.3646L5.63574 16.9504L10.5855 12.0007L5.63574 7.05093L7.04996 5.63672L11.9997 10.5865Z" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </div>
                      {item.status === "converting" && item.filePercent != null && (
                        <div
                          className="queue-progress-bar"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(item.filePercent)}
                          aria-label={`${item.name} progress`}
                        >
                          <div
                            className="queue-progress-fill"
                            style={{ width: `${item.filePercent}%` }}
                          />
                        </div>
                      )}
                      {item.error && <p className="queue-error">{item.error}</p>}
                      {item.outputPath && (
                        <p className="queue-out" title={item.outputPath}>
                          → {fileName(item.outputPath)}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <footer className={`actions${convertLockedClass}`}>
              <button
                type="button"
                className="primary"
                onClick={convert}
                disabled={!canConvert}
                title={convertBlockedReason ?? undefined}
                aria-describedby={
                  convertBlockedReason ? "convert-blocked-hint" : undefined
                }
              >
                {convertButtonLabel}
              </button>
              {convertBlockedReason && (
                <p className="actions-hint" id="convert-blocked-hint" role="status">
                  {convertBlockedReason}
                </p>
              )}
            </footer>
        </div>
      )}

      {activeTab === "preferences" && (
        <div className="tab-panel" role="tabpanel">
          <section className="prefs">
            <h2>FFmpeg output</h2>
            <p className="prefs-intro">
              GIF encoding settings used for every conversion. Height scales automatically from
              width.
            </p>

            <div className="prefs-grid">
              <label className="pref-field">
                <span className="label">FPS</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={ffmpegConfig.fps}
                  disabled={converting}
                  onChange={(event) => updateConfigField("fps", event.target.value)}
                />
                <span className="pref-hint">Frames per second (1–30)</span>
              </label>

              <label className="pref-field">
                <span className="label">Width (px)</span>
                <input
                  type="number"
                  min={1}
                  value={ffmpegConfig.width}
                  disabled={converting}
                  onChange={(event) => updateConfigField("width", event.target.value)}
                />
                <span className="pref-hint">Max GIF width; height keeps aspect ratio</span>
              </label>

              <label className="pref-field">
                <span className="label">Max colors</span>
                <input
                  type="number"
                  min={2}
                  max={256}
                  value={ffmpegConfig.maxColors}
                  disabled={converting}
                  onChange={(event) => updateConfigField("maxColors", event.target.value)}
                />
                <span className="pref-hint">Palette size (2–256)</span>
              </label>
            </div>

            <div className="pref-preview">
              <span className="label">Filter preview</span>
              <code className="pref-preview-code">{filterPreview}</code>
            </div>

            <button
              type="button"
              className="secondary"
              onClick={resetPreferences}
              disabled={converting}
            >
              Reset FFmpeg defaults
            </button>
          </section>

          <section className="prefs">
            <h2>BusinessMap</h2>
            <p className="prefs-intro">
              API key from My Account → API. Used when destination is Post to BusinessMap.
            </p>

            <div className="prefs-grid">
              <label className="pref-field pref-field-wide">
                <span className="label">Base URL</span>
                <input
                  type="url"
                  value={bmBaseUrl}
                  disabled={converting}
                  onChange={(event) => {
                    void persistBmSettings({ baseUrl: event.target.value });
                  }}
                />
              </label>

              <label className="pref-field pref-field-wide">
                <span className="label">API key</span>
                <input
                  type="password"
                  value={bmApiKey}
                  autoComplete="off"
                  disabled={converting}
                  onChange={(event) => {
                    void persistBmSettings({ apiKey: event.target.value });
                  }}
                />
              </label>

              <label className="pref-field pref-field-wide">
                <span className="label">Comment template</span>
                <input
                  type="text"
                  value={bmCommentTemplate}
                  disabled={converting}
                  onChange={(event) => {
                    void persistBmSettings({ commentTemplate: event.target.value });
                  }}
                />
                <span className="pref-hint">Use {"{filename}"} for the attachment name.</span>
              </label>
            </div>

            <div className="pref-actions">
              <button
                type="button"
                className="secondary"
                onClick={testBusinessmapConnection}
                disabled={converting || bmTesting || !bmApiKey.trim()}
              >
                {bmTesting ? "Testing…" : "Test connection"}
              </button>
              {bmTestMessage && (
                <p className={`pref-test ${bmTestMessage.startsWith("Connected") ? "pref-test-ok" : "pref-test-error"}`}>
                  {bmTestMessage}
                </p>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
