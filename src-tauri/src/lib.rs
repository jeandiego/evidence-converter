mod businessmap;
mod images;

use businessmap::BusinessmapConfig;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;

const TOOL_UNAVAILABLE: &str =
    "Bundled ffmpeg is unavailable. Reinstall the app or contact support.";

struct ToolPaths {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

fn sidecar_executable_path(name: &str) -> Result<PathBuf, String> {
    let exe_path = tauri::utils::platform::current_exe()
        .map_err(|e| format!("Failed to locate app executable: {e}"))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "App executable has no parent directory".to_string())?;
    let base_dir = if exe_dir.ends_with("deps") {
        exe_dir.parent().unwrap_or(exe_dir)
    } else {
        exe_dir
    };

    let mut command_path = base_dir.join(name);

    #[cfg(windows)]
    if command_path.extension().is_none() {
        command_path.set_extension("exe");
    }

    if command_path.is_file() {
        Ok(command_path)
    } else {
        Err(format!(
            "Bundled {name} not found at {}",
            command_path.display()
        ))
    }
}

fn resolve_tool(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let _ = app.shell().sidecar(name);

    if let Ok(path) = sidecar_executable_path(name) {
        return Ok(path);
    }

    which::which(name).map_err(|_| TOOL_UNAVAILABLE.to_string())
}

fn resolve_tools(app: &AppHandle) -> Result<ToolPaths, String> {
    Ok(ToolPaths {
        ffmpeg: resolve_tool(app, "ffmpeg")?,
        ffprobe: resolve_tool(app, "ffprobe")?,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegStatus {
    available: bool,
    message: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegConfig {
    fps: u32,
    width: u32,
    max_colors: u32,
}

impl Default for FfmpegConfig {
    fn default() -> Self {
        Self {
            fps: 10,
            width: 480,
            max_colors: 128,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConvertResult {
    name: String,
    ok: bool,
    error: Option<String>,
    output_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConvertBatchStarted {
    total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConvertFileStarted {
    index: usize,
    total: usize,
    name: String,
    path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConvertProgress {
    index: usize,
    total: usize,
    name: String,
    path: String,
    file_percent: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConvertFileFinished {
    index: usize,
    total: usize,
    name: String,
    path: String,
    ok: bool,
    error: Option<String>,
    output_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConvertBatchFinished {
    ok: usize,
    failed: usize,
    destination: String,
    card_id: Option<u64>,
    card_url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConvertFileUploading {
    index: usize,
    total: usize,
    name: String,
    path: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ConvertDestination {
    Local,
    Businessmap,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BusinessmapOptions {
    card_url: String,
    api_key: String,
    base_url: String,
    comment_template: String,
}

fn validate_config(config: &FfmpegConfig) -> Result<(), String> {
    if config.fps == 0 {
        return Err("FPS must be at least 1".to_string());
    }
    if config.fps > 30 {
        return Err("FPS must be 30 or less".to_string());
    }
    if config.width == 0 {
        return Err("Width must be at least 1 pixel".to_string());
    }
    if config.max_colors < 2 {
        return Err("Max colors must be at least 2".to_string());
    }
    if config.max_colors > 256 {
        return Err("Max colors must be 256 or less".to_string());
    }
    Ok(())
}

fn build_gif_filter(config: &FfmpegConfig) -> String {
    format!(
        "fps={},scale={}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors={}[p];[s1][p]paletteuse",
        config.fps, config.width, config.max_colors
    )
}

fn is_supported_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            lower == "mov" || lower == "mp4"
        })
        .unwrap_or(false)
}

fn truncate_stderr(stderr: &str, max_chars: usize) -> String {
    let trimmed = stderr.trim();
    if trimmed.len() <= max_chars {
        return trimmed.to_string();
    }
    let start = trimmed.len().saturating_sub(max_chars);
    format!("…{}", &trimmed[start..])
}

fn probe_duration_secs(tools: &ToolPaths, path: &str) -> Option<f64> {
    let output = Command::new(&tools.ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|d| *d > 0.0)
}

fn parse_progress_value(line: &str) -> Option<f64> {
    let (_, value) = line.split_once('=')?;
    value.trim().parse::<f64>().ok()
}

fn emit_progress(app: Option<&AppHandle>, payload: ConvertProgress) {
    if let Some(app) = app {
        let _ = app.emit("convert-progress", payload);
    }
}

fn run_ffmpeg_with_progress(
    tools: &ToolPaths,
    app: Option<&AppHandle>,
    input_path: &str,
    output_path: &str,
    filter: &str,
    index: usize,
    total: usize,
    name: &str,
) -> Result<(), String> {
    let mut child = Command::new(&tools.ffmpeg)
        .args([
            "-y",
            "-i",
            input_path,
            "-vf",
            filter,
            "-progress",
            "pipe:1",
            "-nostats",
            output_path,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run ffmpeg: {e}"))?;

    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    let stderr_capture = Arc::clone(&stderr_buffer);

    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let mut buf = stderr_capture.lock().unwrap_or_else(|e| e.into_inner());
                buf.push_str(&line);
                buf.push('\n');
            }
        });
    }

    let stdout = child.stdout.take().ok_or("Failed to capture ffmpeg stdout")?;
    let reader = BufReader::new(stdout);

    let duration_secs = probe_duration_secs(tools, input_path);
    let mut last_emit = Instant::now() - Duration::from_millis(500);
    let mut last_percent = -1.0f64;

    for line in reader.lines() {
        let line = line.map_err(|e| format!("Failed to read ffmpeg progress: {e}"))?;

        if line.starts_with("out_time_ms=") {
            let out_time_ms = parse_progress_value(&line).unwrap_or(0.0);
            let file_percent = duration_secs
                .map(|duration| {
                    let out_secs = out_time_ms / 1_000_000.0;
                    ((out_secs / duration) * 100.0).clamp(0.0, 99.0)
                })
                .unwrap_or(-1.0);

            let should_emit = file_percent < 0.0
                || (file_percent - last_percent).abs() >= 1.0
                || last_emit.elapsed() >= Duration::from_millis(150);

            if should_emit {
                emit_progress(
                    app,
                    ConvertProgress {
                        index,
                        total,
                        name: name.to_string(),
                        path: input_path.to_string(),
                        file_percent: if file_percent < 0.0 {
                            0.0
                        } else {
                            file_percent
                        },
                    },
                );
                last_percent = file_percent;
                last_emit = Instant::now();
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for ffmpeg: {e}"))?;

    if status.success() {
        emit_progress(
            app,
            ConvertProgress {
                index,
                total,
                name: name.to_string(),
                path: input_path.to_string(),
                file_percent: 100.0,
            },
        );
        Ok(())
    } else {
        let stderr = stderr_buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        Err(truncate_stderr(&stderr, 400))
    }
}

#[tauri::command]
fn check_ffmpeg(app: AppHandle) -> FfmpegStatus {
    match resolve_tool(&app, "ffmpeg") {
        Ok(path) => match Command::new(&path).arg("-version").output() {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let first_line = stdout.lines().next().unwrap_or("ffmpeg available").to_string();
                FfmpegStatus {
                    available: true,
                    message: first_line,
                }
            }
            Ok(output) => FfmpegStatus {
                available: false,
                message: format!(
                    "ffmpeg exited with {}. {}",
                    output.status, TOOL_UNAVAILABLE
                ),
            },
            Err(error) => FfmpegStatus {
                available: false,
                message: format!("Failed to run ffmpeg: {error}. {TOOL_UNAVAILABLE}"),
            },
        },
        Err(message) => FfmpegStatus {
            available: false,
            message,
        },
    }
}

fn paths_need_ffmpeg(paths: &[String]) -> bool {
    paths.iter().any(|path_str| {
        is_supported_video(Path::new(path_str))
    })
}

fn convert_videos_inner(
    app: AppHandle,
    tools: Option<ToolPaths>,
    paths: Vec<String>,
    output_dir: PathBuf,
    config: FfmpegConfig,
    destination: ConvertDestination,
    businessmap: Option<BusinessmapOptions>,
) {
    let filter = build_gif_filter(&config);
    let total = paths.len();
    let mut ok_count = 0usize;
    let mut failed_count = 0usize;

    let bm_config = if destination == ConvertDestination::Businessmap {
        let options = businessmap.as_ref().expect("BusinessMap options required");
        Some(BusinessmapConfig {
            base_url: options.base_url.clone(),
            api_key: options.api_key.clone(),
            card_url: options.card_url.clone(),
            comment_template: options.comment_template.clone(),
        })
    } else {
        None
    };

    let card_id = bm_config
        .as_ref()
        .and_then(|cfg| businessmap::parse_card_id(&cfg.card_url).ok());
    let card_url = bm_config.as_ref().map(|cfg| cfg.card_url.clone());

    let _ = app.emit(
        "convert-batch-started",
        ConvertBatchStarted { total },
    );

    for (index, path_str) in paths.into_iter().enumerate() {
        let input = PathBuf::from(&path_str);
        let name = input
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&path_str)
            .to_string();

        let _ = app.emit(
            "convert-file-started",
            ConvertFileStarted {
                index,
                total,
                name: name.clone(),
                path: path_str.clone(),
            },
        );

        if !input.is_file() {
            failed_count += 1;
            let result = ConvertResult {
                name: name.clone(),
                ok: false,
                error: Some("File not found".to_string()),
                output_path: None,
            };
            emit_file_finished(&app, index, total, &path_str, &result);
            continue;
        }

        if images::is_supported_image(&input) {
            match destination {
                ConvertDestination::Businessmap => {
                    let bm = bm_config.as_ref().expect("BusinessMap config");
                    let card_id = businessmap::parse_card_id(&bm.card_url).unwrap_or(0);

                    let _ = app.emit(
                        "convert-file-uploading",
                        ConvertFileUploading {
                            index,
                            total,
                            name: name.clone(),
                            path: path_str.clone(),
                        },
                    );

                    match images::prepare_image_for_upload(&input) {
                        Ok((bytes, upload_name, mime_type)) => {
                            match post_attachment_to_businessmap(
                                bm,
                                card_id,
                                &upload_name,
                                mime_type,
                                &bytes,
                            ) {
                                Ok(()) => {
                                    ok_count += 1;
                                    let result = ConvertResult {
                                        name: name.clone(),
                                        ok: true,
                                        error: None,
                                        output_path: None,
                                    };
                                    emit_file_finished(&app, index, total, &path_str, &result);
                                }
                                Err(error) => {
                                    failed_count += 1;
                                    let result = ConvertResult {
                                        name: name.clone(),
                                        ok: false,
                                        error: Some(error),
                                        output_path: None,
                                    };
                                    emit_file_finished(&app, index, total, &path_str, &result);
                                }
                            }
                        }
                        Err(error) => {
                            failed_count += 1;
                            let result = ConvertResult {
                                name: name.clone(),
                                ok: false,
                                error: Some(error),
                                output_path: None,
                            };
                            emit_file_finished(&app, index, total, &path_str, &result);
                        }
                    }
                }
                ConvertDestination::Local => {
                    failed_count += 1;
                    let result = ConvertResult {
                        name: name.clone(),
                        ok: false,
                        error: Some("Images can only be posted to BusinessMap".to_string()),
                        output_path: None,
                    };
                    emit_file_finished(&app, index, total, &path_str, &result);
                }
            }
            continue;
        }

        if !is_supported_video(&input) {
            failed_count += 1;
            let unsupported_message = if destination == ConvertDestination::Businessmap {
                "Unsupported format (use .mov, .mp4, .jpg, or .png)".to_string()
            } else {
                "Unsupported format (use .mov or .mp4)".to_string()
            };
            let result = ConvertResult {
                name: name.clone(),
                ok: false,
                error: Some(unsupported_message),
                output_path: None,
            };
            emit_file_finished(&app, index, total, &path_str, &result);
            continue;
        }

        let tools = match tools.as_ref() {
            Some(tools) => tools,
            None => {
                failed_count += 1;
                let result = ConvertResult {
                    name: name.clone(),
                    ok: false,
                    error: Some(TOOL_UNAVAILABLE.to_string()),
                    output_path: None,
                };
                emit_file_finished(&app, index, total, &path_str, &result);
                continue;
            }
        };

        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("output");
        let output_path = output_dir.join(format!("{stem}.gif"));
        let output_path_str = output_path.to_string_lossy().to_string();

        let convert_result = run_ffmpeg_with_progress(
            &tools,
            Some(&app),
            &path_str,
            &output_path_str,
            &filter,
            index,
            total,
            &name,
        );

        match convert_result {
            Ok(()) if destination == ConvertDestination::Businessmap => {
                let bm = bm_config.as_ref().expect("BusinessMap config");
                let card_id = businessmap::parse_card_id(&bm.card_url).unwrap_or(0);
                let gif_name = output_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("evidence.gif")
                    .to_string();

                let _ = app.emit(
                    "convert-file-uploading",
                    ConvertFileUploading {
                        index,
                        total,
                        name: name.clone(),
                        path: path_str.clone(),
                    },
                );

                let upload_result = fs::read(&output_path)
                    .map_err(|e| format!("Failed to read GIF: {e}"))
                    .and_then(|bytes| {
                        post_attachment_to_businessmap(
                            bm,
                            card_id,
                            &gif_name,
                            "image/gif",
                            &bytes,
                        )
                    });

                match upload_result {
                    Ok(()) => {
                        cleanup_temp_gif(&output_path);
                        ok_count += 1;
                        let result = ConvertResult {
                            name: name.clone(),
                            ok: true,
                            error: None,
                            output_path: None,
                        };
                        emit_file_finished(&app, index, total, &path_str, &result);
                    }
                    Err(error) => {
                        failed_count += 1;
                        let result = ConvertResult {
                            name: name.clone(),
                            ok: false,
                            error: Some(error),
                            output_path: Some(output_path_str),
                        };
                        emit_file_finished(&app, index, total, &path_str, &result);
                    }
                }
            }
            Ok(()) => {
                ok_count += 1;
                let result = ConvertResult {
                    name: name.clone(),
                    ok: true,
                    error: None,
                    output_path: Some(output_path_str),
                };
                emit_file_finished(&app, index, total, &path_str, &result);
            }
            Err(error) => {
                failed_count += 1;
                let result = ConvertResult {
                    name: name.clone(),
                    ok: false,
                    error: Some(error),
                    output_path: None,
                };
                emit_file_finished(&app, index, total, &path_str, &result);
            }
        }
    }

    if destination == ConvertDestination::Businessmap {
        cleanup_batch_temp_dir(&output_dir);
    }

    let destination_label = if destination == ConvertDestination::Businessmap {
        "businessmap".to_string()
    } else {
        "local".to_string()
    };

    let _ = app.emit(
        "convert-batch-finished",
        ConvertBatchFinished {
            ok: ok_count,
            failed: failed_count,
            destination: destination_label,
            card_id,
            card_url,
        },
    );
}

fn post_attachment_to_businessmap(
    config: &BusinessmapConfig,
    card_id: u64,
    file_name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let link = businessmap::upload_file(
        &config.base_url,
        &config.api_key,
        file_name,
        bytes,
        mime_type,
    )?;
    let comment = businessmap::render_comment_template(&config.comment_template, file_name);
    businessmap::post_comment_with_attachment(
        &config.base_url,
        &config.api_key,
        card_id,
        &comment,
        file_name,
        &link,
    )
}

fn cleanup_temp_gif(gif_path: &Path) {
    let _ = fs::remove_file(gif_path);
}

fn cleanup_batch_temp_dir(dir: &Path) {
    if !dir.is_dir() {
        return;
    }
    let _ = fs::remove_dir_all(dir);
    if let Some(parent) = dir.parent() {
        if parent.file_name().and_then(|n| n.to_str()) == Some("evidence-cvt") {
            cleanup_temp_dir_if_empty(parent);
        }
    }
}

fn cleanup_temp_dir_if_empty(dir: &Path) {
    if !dir.is_dir() {
        return;
    }
    let is_empty = fs::read_dir(dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false);
    if is_empty {
        let _ = fs::remove_dir(dir);
        if let Some(parent) = dir.parent() {
            if parent.file_name().and_then(|n| n.to_str()) == Some("evidence-cvt") {
                let _ = fs::remove_dir(parent);
            }
        }
    }
}

fn create_batch_output_dir(destination: ConvertDestination) -> Result<PathBuf, String> {
    match destination {
        ConvertDestination::Local => Err("Local destination requires an output directory".to_string()),
        ConvertDestination::Businessmap => {
            let batch_id = format!("{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0));
            let dir = std::env::temp_dir()
                .join("evidence-cvt")
                .join(batch_id);
            fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp directory: {e}"))?;
            Ok(dir)
        }
    }
}

#[tauri::command]
fn test_businessmap_connection(base_url: String, api_key: String) -> Result<String, String> {
    businessmap::test_connection(&base_url, &api_key)
}

#[tauri::command]
async fn convert_videos(
    app: AppHandle,
    paths: Vec<String>,
    output_dir: Option<String>,
    destination: ConvertDestination,
    businessmap: Option<BusinessmapOptions>,
    config: FfmpegConfig,
) -> Result<(), String> {
    validate_config(&config)?;

    if paths.is_empty() {
        return Err("No files to convert".to_string());
    }

    let out_dir = match destination {
        ConvertDestination::Local => {
            let dir = output_dir.ok_or_else(|| "Output directory is required".to_string())?;
            let path = PathBuf::from(&dir);
            if !path.is_dir() {
                return Err(format!(
                    "Output directory does not exist or is not a folder: {dir}"
                ));
            }
            path
        }
        ConvertDestination::Businessmap => {
            let options = businessmap
                .as_ref()
                .ok_or_else(|| "BusinessMap settings are required".to_string())?;
            businessmap::validate_card_path(&options.card_url)?;
            if options.api_key.trim().is_empty() {
                return Err("BusinessMap API key is required".to_string());
            }
            create_batch_output_dir(destination)?
        }
    };

    let tools = if paths_need_ffmpeg(&paths) {
        Some(resolve_tools(&app)?)
    } else {
        None
    };
    let bm_options = businessmap;
    tauri::async_runtime::spawn_blocking(move || {
        convert_videos_inner(
            app,
            tools,
            paths,
            out_dir,
            config,
            destination,
            bm_options,
        );
    });

    Ok(())
}

fn emit_file_finished(
    app: &AppHandle,
    index: usize,
    total: usize,
    path: &str,
    result: &ConvertResult,
) {
    let _ = app.emit(
        "convert-file-finished",
        ConvertFileFinished {
            index,
            total,
            name: result.name.clone(),
            path: path.to_string(),
            ok: result.ok,
            error: result.error.clone(),
            output_path: result.output_path.clone(),
        },
    );
}

#[cfg(target_os = "macos")]
fn configure_macos_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use tauri::window::{Color, Effect, EffectState, EffectsBuilder};

    window.set_background_color(Some(Color(0, 0, 0, 0)))?;
    window.set_effects(
        EffectsBuilder::new()
            .effect(Effect::HudWindow)
            .state(EffectState::Active)
            .radius(12.0)
            .build(),
    )?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn configure_windows_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use tauri::window::{Color, Effect, EffectsBuilder};

    window.set_background_color(Some(Color(0, 0, 0, 0)))?;

    let tabbed = window.set_effects(EffectsBuilder::new().effect(Effect::Tabbed).build());
    if tabbed.is_ok() {
        return Ok(());
    }

    let mica = window.set_effects(EffectsBuilder::new().effect(Effect::Mica).build());
    if mica.is_ok() {
        return Ok(());
    }

    let _ = window.set_effects(
        EffectsBuilder::new()
            .effect(Effect::Acrylic)
            .color(Color(32, 32, 32, 180))
            .build(),
    );

    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn configure_platform_window(_window: &tauri::WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn configure_platform_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    configure_windows_window(window)
}

#[cfg(target_os = "macos")]
fn configure_platform_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    configure_macos_window(window)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn load_tray_icon() -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn toggle_tray_panel(app: &tauri::AppHandle) {
    use tauri::Manager;
    use tauri_plugin_positioner::{Position, WindowExt};

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    let _ = window.as_ref().window().move_window(Position::TrayCenter);
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(target_os = "macos")]
fn macos_menu_click() -> bool {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags};

    NSEvent::modifierFlags_class().contains(NSEventModifierFlags::Control)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        Manager,
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;

    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        {
            let _ = window.set_visible_on_all_workspaces(true);
        }
        let _ = window.hide();
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app.handle().set_dock_visibility(false)?;
    }

    let icon = load_tray_icon()?;

    let mut builder = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Evidence GIF Converter")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            if let TrayIconEvent::Click {
                button,
                button_state: MouseButtonState::Down,
                ..
            } = event
            {
                let open_menu = match button {
                    MouseButton::Right => true,
                    MouseButton::Left => {
                        #[cfg(target_os = "macos")]
                        {
                            macos_menu_click()
                        }
                        #[cfg(target_os = "windows")]
                        {
                            false
                        }
                    }
                    _ => false,
                };

                if open_menu {
                    let _ = tray.with_inner_tray_icon(|inner| inner.show_menu());
                } else if matches!(button, MouseButton::Left) {
                    toggle_tray_panel(tray.app_handle());
                }
            }
        });

    #[cfg(target_os = "macos")]
    {
        builder = builder.icon_as_template(true);
    }

    let tray = builder.build(app)?;

    tray.with_inner_tray_icon(|inner| {
        inner.set_show_menu_on_left_click(false);
        inner.set_show_menu_on_right_click(true);
    })?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            use tauri::Manager;

            if let Some(window) = app.get_webview_window("main") {
                configure_platform_window(&window)?;
            }

            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                app.handle().plugin(tauri_plugin_positioner::init())?;
                setup_tray(app)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            convert_videos,
            test_businessmap_connection
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    #[test]
    fn build_gif_filter_uses_config() {
        let config = FfmpegConfig {
            fps: 15,
            width: 720,
            max_colors: 64,
        };
        let filter = build_gif_filter(&config);
        assert!(filter.contains("fps=15"));
        assert!(filter.contains("scale=720:-1"));
        assert!(filter.contains("max_colors=64"));
    }

    #[test]
    fn validate_config_rejects_invalid_values() {
        assert!(validate_config(&FfmpegConfig {
            fps: 0,
            width: 480,
            max_colors: 128,
        })
        .is_err());
        assert!(validate_config(&FfmpegConfig {
            fps: 10,
            width: 0,
            max_colors: 128,
        })
        .is_err());
        assert!(validate_config(&FfmpegConfig {
            fps: 10,
            width: 480,
            max_colors: 1,
        })
        .is_err());
    }

    #[test]
    fn cleanup_temp_gif_keeps_batch_dir_for_remaining_files() {
        let batch_dir = std::env::temp_dir().join("evidence-cvt-cleanup-test");
        let _ = fs::remove_dir_all(&batch_dir);
        fs::create_dir_all(&batch_dir).unwrap();

        let first = batch_dir.join("first.gif");
        let second = batch_dir.join("second.gif");
        fs::write(&first, b"GIF89a").unwrap();
        fs::write(&second, b"GIF89a").unwrap();

        cleanup_temp_gif(&first);

        assert!(!first.exists());
        assert!(second.exists());
        assert!(batch_dir.is_dir());

        cleanup_batch_temp_dir(&batch_dir);
        assert!(!batch_dir.exists());
    }

    #[test]
    fn convert_sample_mp4_to_gif() {
        let dir = std::env::temp_dir().join("evidence-cvt-unit");
        let out = dir.join("out");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&out).unwrap();

        let input = dir.join("clip.mp4");
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=0.5:size=320x240:rate=15",
                "-pix_fmt",
                "yuv420p",
                input.to_str().unwrap(),
            ])
            .status()
            .expect("ffmpeg required for test");
        assert!(status.success());

        let filter = build_gif_filter(&FfmpegConfig::default());
        let output_path = out.join("clip.gif");
        let tools = ToolPaths {
            ffmpeg: which::which("ffmpeg").expect("ffmpeg required for test"),
            ffprobe: which::which("ffprobe").expect("ffprobe required for test"),
        };
        run_ffmpeg_with_progress(
            &tools,
            None,
            input.to_str().unwrap(),
            output_path.to_str().unwrap(),
            &filter,
            0,
            1,
            "clip.mp4",
        )
        .expect("conversion failed");

        assert!(output_path.exists());
        assert_eq!(output_path.extension().unwrap(), "gif");
    }
}
