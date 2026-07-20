use serde::{Deserialize, Serialize};
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

fn convert_videos_inner(
    app: AppHandle,
    tools: ToolPaths,
    paths: Vec<String>,
    output_dir: String,
    config: FfmpegConfig,
) {
    let out_dir = PathBuf::from(&output_dir);
    let filter = build_gif_filter(&config);
    let total = paths.len();
    let mut ok_count = 0usize;
    let mut failed_count = 0usize;

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

        if !is_supported_video(&input) {
            failed_count += 1;
            let result = ConvertResult {
                name: name.clone(),
                ok: false,
                error: Some("Unsupported format (use .mov or .mp4)".to_string()),
                output_path: None,
            };
            emit_file_finished(&app, index, total, &path_str, &result);
            continue;
        }

        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("output");
        let output_path = out_dir.join(format!("{stem}.gif"));
        let output_path_str = output_path.to_string_lossy().to_string();

        match run_ffmpeg_with_progress(
            &tools,
            Some(&app),
            &path_str,
            &output_path_str,
            &filter,
            index,
            total,
            &name,
        ) {
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

    let _ = app.emit(
        "convert-batch-finished",
        ConvertBatchFinished {
            ok: ok_count,
            failed: failed_count,
        },
    );
}

#[tauri::command]
async fn convert_videos(
    app: AppHandle,
    paths: Vec<String>,
    output_dir: String,
    config: FfmpegConfig,
) -> Result<(), String> {
    validate_config(&config)?;

    let out_dir = PathBuf::from(&output_dir);
    if !out_dir.is_dir() {
        return Err(format!(
            "Output directory does not exist or is not a folder: {}",
            output_dir
        ));
    }

    if paths.is_empty() {
        return Err("No files to convert".to_string());
    }

    let tools = resolve_tools(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        convert_videos_inner(app, tools, paths, output_dir, config);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![check_ffmpeg, convert_videos])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
