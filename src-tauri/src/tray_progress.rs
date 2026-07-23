use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::tray::TrayIcon;
use tauri::Manager;

const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon.png");
const DEFAULT_TOOLTIP: &str = "Evidence GIF Converter";
const BAR_HEIGHT_RATIO: f64 = 0.24;
const MIN_BAR_HEIGHT: u32 = 5;

pub struct TrayProgress {
    tray: TrayIcon,
    base_rgba: Vec<u8>,
    width: u32,
    height: u32,
    last_update: Mutex<Option<Instant>>,
}

pub fn decode_base_icon() -> (Vec<u8>, u32, u32) {
    let image = image::load_from_memory(TRAY_ICON_BYTES).expect("tray icon PNG");
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    (rgba.into_raw(), width, height)
}

pub fn overall_percent(index: usize, total: usize, file_percent: f64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    let completed = index as f64 + file_percent.clamp(0.0, 100.0) / 100.0;
    (completed / total as f64 * 100.0).clamp(0.0, 100.0)
}

pub fn render_progress_icon(base: &[u8], width: u32, height: u32, percent: f64) -> Vec<u8> {
    let mut pixels = base.to_vec();
    draw_progress_bar(&mut pixels, width, height, percent);
    pixels
}

fn bar_height_for_icon(height: u32) -> u32 {
    if height == 0 {
        return 0;
    }
    let computed = (height as f64 * BAR_HEIGHT_RATIO).round() as u32;
    computed.clamp(MIN_BAR_HEIGHT, height.saturating_sub(2))
}

fn draw_progress_bar(pixels: &mut [u8], width: u32, height: u32, percent: f64) {
    if width == 0 || height == 0 {
        return;
    }

    let bar_height = bar_height_for_icon(height);
    let bar_top = height.saturating_sub(bar_height);
    let fill_width = ((width as f64) * (percent.clamp(0.0, 100.0) / 100.0)).round() as u32;

    for y in bar_top..height {
        for x in 0..width {
            let idx = ((y * width + x) * 4) as usize;
            if idx + 3 >= pixels.len() {
                continue;
            }

            let is_fill = x < fill_width;
            let is_top_edge = y == bar_top;
            let is_bottom_edge = y == height - 1;

            #[cfg(target_os = "macos")]
            {
                pixels[idx] = 255;
                pixels[idx + 1] = 255;
                pixels[idx + 2] = 255;
                pixels[idx + 3] = if is_top_edge || is_bottom_edge {
                    210
                } else if is_fill {
                    255
                } else {
                    90
                };
            }
            #[cfg(not(target_os = "macos"))]
            {
                if is_top_edge || is_bottom_edge || x == 0 || x == width - 1 {
                    pixels[idx] = 40;
                    pixels[idx + 1] = 40;
                    pixels[idx + 2] = 40;
                    pixels[idx + 3] = 230;
                } else if is_fill {
                    pixels[idx] = 10;
                    pixels[idx + 1] = 132;
                    pixels[idx + 2] = 255;
                    pixels[idx + 3] = 255;
                } else {
                    pixels[idx] = 150;
                    pixels[idx + 1] = 150;
                    pixels[idx + 2] = 150;
                    pixels[idx + 3] = 210;
                }
            }
        }
    }
}

impl TrayProgress {
    pub fn new(tray: TrayIcon, base_rgba: Vec<u8>, width: u32, height: u32) -> Self {
        Self {
            tray,
            base_rgba,
            width,
            height,
            last_update: Mutex::new(None),
        }
    }

    pub fn set_progress(&self, percent: f64, tooltip: &str) -> tauri::Result<()> {
        {
            let mut last = self
                .last_update
                .lock()
                .expect("tray progress lock poisoned");
            if let Some(instant) = *last {
                if percent < 100.0 && instant.elapsed() < Duration::from_millis(100) {
                    return Ok(());
                }
            }
            *last = Some(Instant::now());
        }

        let rgba = render_progress_icon(&self.base_rgba, self.width, self.height, percent);
        let icon = tauri::image::Image::new_owned(rgba, self.width, self.height);

        #[cfg(target_os = "macos")]
        self.tray.set_icon_with_as_template(Some(icon), true)?;
        #[cfg(not(target_os = "macos"))]
        self.tray.set_icon(Some(icon))?;

        self.tray.set_tooltip(Some(tooltip))?;
        Ok(())
    }

    pub fn reset(&self) -> tauri::Result<()> {
        {
            let mut last = self
                .last_update
                .lock()
                .expect("tray progress lock poisoned");
            *last = None;
        }

        let icon = tauri::image::Image::from_bytes(TRAY_ICON_BYTES)?;
        #[cfg(target_os = "macos")]
        self.tray.set_icon_with_as_template(Some(icon), true)?;
        #[cfg(not(target_os = "macos"))]
        self.tray.set_icon(Some(icon))?;

        self.tray.set_tooltip(Some(DEFAULT_TOOLTIP))?;
        Ok(())
    }
}

pub fn set_tray_progress(
    app: &tauri::AppHandle,
    index: usize,
    total: usize,
    file_percent: f64,
    file_name: &str,
) {
    let Some(state) = app.try_state::<TrayProgress>() else {
        return;
    };

    let percent = overall_percent(index, total, file_percent);
    let tooltip = if total == 0 {
        DEFAULT_TOOLTIP.to_string()
    } else {
        format!(
            "{DEFAULT_TOOLTIP} — {percent:.0}% ({current}/{total}): {file_name}",
            current = index + 1,
        )
    };

    let _ = state.set_progress(percent, &tooltip);
}

pub fn reset_tray_progress(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<TrayProgress>() else {
        return;
    };
    let _ = state.reset();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overall_percent_matches_frontend_formula() {
        assert_eq!(overall_percent(0, 5, 0.0), 0.0);
        assert_eq!(overall_percent(0, 5, 50.0), 10.0);
        assert_eq!(overall_percent(2, 5, 100.0), 60.0);
        assert_eq!(overall_percent(4, 5, 100.0), 100.0);
    }

    #[test]
    fn render_progress_icon_preserves_dimensions() {
        let (base, width, height) = decode_base_icon();
        let rendered = render_progress_icon(&base, width, height, 50.0);
        assert_eq!(rendered.len(), base.len());
    }

    #[test]
    fn bar_height_scales_with_icon_size() {
        assert_eq!(bar_height_for_icon(240), 58);
        assert_eq!(bar_height_for_icon(24), 6);
        assert_eq!(bar_height_for_icon(0), 0);
    }
}
