import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { Store } from "@tauri-apps/plugin-store";
import {
  hideMacosWindow,
  initMacosWindow,
  isMacosPlatform,
} from "./platform/macosWindow";
import "./App.css";

type TabId = "convert" | "preferences";
type QueueStatus = "pending" | "converting" | "done" | "error";

type QueueItem = {
  path: string;
  name: string;
  status: QueueStatus;
  error?: string;
  outputPath?: string;
  filePercent?: number;
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

type ConvertBatchFinished = { ok: number; failed: number };

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
const VIDEO_EXT = /\.(mov|mp4)$/i;

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

  const filterPreview = useMemo(
    () => buildGifFilterPreview(ffmpegConfig),
    [ffmpegConfig],
  );

  const dropzoneHint = useMemo(
    () =>
      `.mov and .mp4 · fps ${ffmpegConfig.fps} · width ${ffmpegConfig.width} · ${ffmpegConfig.maxColors} colors`,
    [ffmpegConfig],
  );

  useEffect(() => {
    initMacosWindow().catch(console.error);
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
          const { ok, failed } = event.payload;
          setConverting(false);
          setProgress(null);
          setNotice(
            failed === 0
              ? `Converted ${ok} file${ok === 1 ? "" : "s"}.`
              : `Converted ${ok}, failed ${failed}.`,
          );
        }),
      );
    }

    setupListeners().catch(console.error);

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  const addPaths = useCallback((paths: string[]) => {
    const videos = paths.filter(isVideoPath);
    const skipped = paths.length - videos.length;

    if (skipped > 0) {
      setNotice(
        skipped === 1
          ? "Skipped 1 non-video file (.mov / .mp4 only)."
          : `Skipped ${skipped} non-video files (.mov / .mp4 only).`,
      );
    } else {
      setNotice(null);
    }

    if (videos.length === 0) return;

    setQueue((prev) => {
      const existing = new Set(prev.map((item) => item.path));
      const next = videos
        .filter((path) => !existing.has(path))
        .map((path) => ({
          path,
          name: fileName(path),
          status: "pending" as const,
        }));
      return next.length ? [...prev, ...next] : prev;
    });
  }, []);

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
    const selected = await open({
      multiple: true,
      filters: [{ name: "Video", extensions: ["mov", "mp4"] }],
    });
    if (selected == null) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    addPaths(paths);
  }

  function clearQueue() {
    setQueue((prev) => {
      if (converting) {
        return prev.filter((item) => item.status === "converting");
      }
      return [];
    });
    if (!converting) setNotice(null);
  }

  function removeItem(path: string) {
    setQueue((prev) => {
      const item = prev.find((entry) => entry.path === path);
      if (!item || item.status === "converting") return prev;
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

  const pendingCount = useMemo(
    () => queue.filter((item) => item.status === "pending" || item.status === "error").length,
    [queue],
  );

  const doneCount = useMemo(
    () => queue.filter((item) => item.status === "done").length,
    [queue],
  );

  async function convert() {
    if (converting) return;

    if (!outputDir) {
      setNotice("Choose an output folder first.");
      return;
    }
    if (!ffmpeg?.available) {
      setNotice(ffmpeg?.message ?? "ffmpeg is not available.");
      return;
    }

    const toConvert = queue.filter(
      (item) => item.status === "pending" || item.status === "error",
    );
    if (toConvert.length === 0) {
      setNotice("Add at least one .mov or .mp4 file.");
      return;
    }

    setConverting(true);
    setNotice(null);
    setProgress({
      active: true,
      current: 0,
      total: toConvert.length,
      fileName: "",
      filePercent: 0,
    });

    try {
      await invoke("convert_videos", {
        paths: toConvert.map((item) => item.path),
        outputDir,
        config: clampConfig(ffmpegConfig),
      });
    } catch (err) {
      setConverting(false);
      setProgress(null);
      setNotice(String(err));
    }
  }

  const progressPercent = progress ? overallPercent(progress) : 0;

  return (
    <main className={`app${isMacos ? " app-macos" : ""}`}>
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
              hideMacosWindow().catch(console.error);
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" 
              width="24" 
              height="24"
              fill="rgba(255,255,255,1)"><path d="M11.9997 10.5865L16.9495 5.63672L18.3637 7.05093L13.4139 12.0007L18.3637 16.9504L16.9495 18.3646L11.9997 13.4149L7.04996 18.3646L5.63574 16.9504L10.5855 12.0007L5.63574 7.05093L7.04996 5.63672L11.9997 10.5865Z"></path></svg>
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

      {ffmpeg && !ffmpeg.available && (
        <div className="banner banner-error" role="alert">
          {ffmpeg.message}
        </div>
      )}
      {activeTab === "convert" && (
        <div className="tab-panel" role="tabpanel">
          <section className="dir-row">
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

          <section
            className={`dropzone ${dropActive ? "dropzone-active" : ""}`}
            aria-label="Drop video files here"
          >
            <p className="dropzone-title">Drag & drop videos here</p>
            <p className="dropzone-hint">{dropzoneHint}</p>
            <button type="button" className="secondary" onClick={addFiles}>
              Add files…
            </button>
          </section>

          {notice && <p className="notice">{notice}</p>}

          {progress?.active && (
            <section className="progress-panel" aria-live="polite">
              <div className="progress-header">
                <span className="progress-label">
                  {progress.fileName
                    ? `Converting ${progress.current + 1} of ${progress.total}: ${progress.fileName}`
                    : `Preparing ${progress.total} file${progress.total === 1 ? "" : "s"}…`}
                </span>
                <span className="progress-percent">{Math.round(progressPercent)}%</span>
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
          )}

          <section className="queue">
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
                disabled={queue.length === 0}
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
                    <div className="queue-item-main">
                      <span className="queue-name" title={item.path}>
                        {item.name}
                      </span>
                      <span className="queue-status">
                        {item.status === "converting" && item.filePercent != null
                          ? `${Math.round(item.filePercent)}%`
                          : item.status}
                      </span>
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
                    {item.status !== "converting" && (
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => removeItem(item.path)}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <footer className="actions">
            <button
              type="button"
              className="primary"
              onClick={convert}
              disabled={
                converting ||
                !outputDir ||
                !ffmpeg?.available ||
                pendingCount === 0
              }
            >
              {converting
                ? "Converting…"
                : pendingCount > 0
                  ? `Convert ${pendingCount}`
                  : "Convert"}
            </button>
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
              Reset to defaults
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
