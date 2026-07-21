use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::{DynamicImage, ExtendedColorType, GenericImageView, ImageEncoder, ImageReader};
use std::fs;
use std::io::Cursor;
use std::path::Path;

const MAX_UPLOAD_BYTES: usize = 1_500_000;
const MAX_SIZE_AFTER_RETRY: usize = 2_000_000;
const MAX_DIMENSION: u32 = 2048;
const RETRY_MAX_DIMENSION: u32 = 1600;
const JPEG_QUALITY: u8 = 85;
const JPEG_QUALITY_RETRY: u8 = 75;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImageFormatKind {
    Jpeg,
    Png,
}

impl ImageFormatKind {
    fn mime_type(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
        }
    }
}

pub fn is_supported_image(path: &Path) -> bool {
    image_format(path).is_some()
}

fn image_format(path: &Path) -> Option<ImageFormatKind> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .and_then(|ext| match ext.as_str() {
            "jpg" | "jpeg" => Some(ImageFormatKind::Jpeg),
            "png" => Some(ImageFormatKind::Png),
            _ => None,
        })
}

fn upload_filename(path: &Path, format: ImageFormatKind) -> String {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        return name.to_string();
    }

    match format {
        ImageFormatKind::Jpeg => "evidence.jpg".to_string(),
        ImageFormatKind::Png => "evidence.png".to_string(),
    }
}

fn decode_image(bytes: &[u8]) -> Result<DynamicImage, String> {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Failed to read image: {e}"))?
        .decode()
        .map_err(|e| format!("Invalid image file: {e}"))
}

fn resize_to_max(img: DynamicImage, max_dim: u32) -> DynamicImage {
    let (width, height) = img.dimensions();
    let longest = width.max(height);
    if longest <= max_dim {
        return img;
    }

    let scale = max_dim as f32 / longest as f32;
    let new_width = ((width as f32 * scale).round() as u32).max(1);
    let new_height = ((height as f32 * scale).round() as u32).max(1);
    img.resize(new_width, new_height, image::imageops::FilterType::Lanczos3)
}

fn encode_image(
    img: &DynamicImage,
    format: ImageFormatKind,
    jpeg_quality: u8,
) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    match format {
        ImageFormatKind::Jpeg => {
            let rgb = img.to_rgb8();
            let encoder = JpegEncoder::new_with_quality(&mut buf, jpeg_quality);
            encoder
                .write_image(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    ExtendedColorType::Rgb8,
                )
                .map_err(|e| format!("Failed to encode JPEG: {e}"))?;
        }
        ImageFormatKind::Png => {
            let rgba = img.to_rgba8();
            let encoder = PngEncoder::new_with_quality(
                &mut buf,
                CompressionType::Default,
                PngFilterType::Adaptive,
            );
            encoder
                .write_image(
                    rgba.as_raw(),
                    rgba.width(),
                    rgba.height(),
                    ExtendedColorType::Rgba8,
                )
                .map_err(|e| format!("Failed to encode PNG: {e}"))?;
        }
    }
    Ok(buf)
}

fn compress_image(
    img: DynamicImage,
    format: ImageFormatKind,
    max_dim: u32,
    jpeg_quality: u8,
) -> Result<Vec<u8>, String> {
    let resized = resize_to_max(img, max_dim);
    encode_image(&resized, format, jpeg_quality)
}

pub fn prepare_image_for_upload(path: &Path) -> Result<(Vec<u8>, String, &'static str), String> {
    let format = image_format(path).ok_or_else(|| {
        "Unsupported image format (use .jpg, .jpeg, or .png)".to_string()
    })?;
    let upload_name = upload_filename(path, format);
    let mime_type = format.mime_type();

    let original_bytes =
        fs::read(path).map_err(|e| format!("Failed to read image: {e}"))?;
    if original_bytes.is_empty() {
        return Err("Image file is empty".to_string());
    }

    decode_image(&original_bytes)?;

    if original_bytes.len() <= MAX_UPLOAD_BYTES {
        return Ok((original_bytes, upload_name, mime_type));
    }

    let img = decode_image(&original_bytes)?;
    let mut compressed = compress_image(img, format, MAX_DIMENSION, JPEG_QUALITY)?;

    if compressed.len() > MAX_SIZE_AFTER_RETRY {
        let img = decode_image(&original_bytes)?;
        compressed = compress_image(img, format, RETRY_MAX_DIMENSION, JPEG_QUALITY_RETRY)?;
    }

    Ok((compressed, upload_name, mime_type))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb, Rgba};

    fn write_temp_jpeg(path: &Path, width: u32, height: u32, quality: u8) {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_fn(width, height, |x, y| {
                Rgb([
                    ((x * 7) % 256) as u8,
                    ((y * 11) % 256) as u8,
                    (((x + y) * 3) % 256) as u8,
                ])
            });
        let dynamic = DynamicImage::ImageRgb8(img);
        let bytes = encode_image(&dynamic, ImageFormatKind::Jpeg, quality).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn write_temp_png(path: &Path, width: u32, height: u32) {
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_fn(width, height, |x, y| {
                Rgba([
                    ((x * 5) % 256) as u8,
                    ((y * 9) % 256) as u8,
                    (((x + y) * 2) % 256) as u8,
                    255,
                ])
            });
        let dynamic = DynamicImage::ImageRgba8(img);
        let bytes = encode_image(&dynamic, ImageFormatKind::Png, JPEG_QUALITY).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn is_supported_image_detects_extensions() {
        assert!(is_supported_image(Path::new("photo.jpg")));
        assert!(is_supported_image(Path::new("photo.JPEG")));
        assert!(is_supported_image(Path::new("shot.png")));
        assert!(!is_supported_image(Path::new("clip.gif")));
        assert!(!is_supported_image(Path::new("clip.mp4")));
    }

    #[test]
    fn small_image_passes_through_unchanged() {
        let dir = std::env::temp_dir().join("evidence-cvt-images-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let path = dir.join("small.png");
        write_temp_png(&path, 64, 64);

        let original = fs::read(&path).unwrap();
        let (bytes, name, mime) = prepare_image_for_upload(&path).unwrap();

        assert_eq!(bytes, original);
        assert_eq!(name, "small.png");
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn large_image_is_compressed() {
        let dir = std::env::temp_dir().join("evidence-cvt-images-test-large");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let path = dir.join("large.jpg");
        write_temp_jpeg(&path, 4000, 4000, 95);
        let original_len = fs::metadata(&path).unwrap().len();
        assert!(original_len > MAX_UPLOAD_BYTES as u64);

        let (bytes, name, mime) = prepare_image_for_upload(&path).unwrap();

        assert!(bytes.len() < original_len as usize);
        assert!(bytes.len() <= MAX_SIZE_AFTER_RETRY);
        assert_eq!(name, "large.jpg");
        assert_eq!(mime, "image/jpeg");
        assert!(decode_image(&bytes).is_ok());
    }
}
