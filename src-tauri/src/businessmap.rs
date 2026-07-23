use rand::Rng;
use regex::Regex;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_BASE_URL: &str = "https://dasa.businessmap.io";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessmapConfig {
    pub base_url: String,
    pub api_key: String,
    pub card_url: String,
    pub comment_template: String,
}

#[derive(Deserialize)]
struct MeResponse {
    data: MeData,
}

#[derive(Deserialize)]
struct MeData {
    username: Option<String>,
    email: Option<String>,
}

#[derive(Deserialize)]
struct UploadResponse {
    resparray: Option<Vec<UploadFileResult>>,
}

#[derive(Deserialize)]
struct UploadFileResult {
    file_name: Option<String>,
    status: Option<String>,
    link: Option<String>,
}

#[derive(Serialize)]
struct CommentCreateBody<'a> {
    text: &'a str,
    attachments_to_add: Vec<CommentAttachment<'a>>,
}

#[derive(Serialize)]
struct CommentAttachment<'a> {
    file_name: &'a str,
    link: &'a str,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    error: Option<ApiErrorDetail>,
}

#[derive(Deserialize)]
struct ApiErrorDetail {
    message: Option<String>,
}

fn normalize_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(DEFAULT_BASE_URL.to_string());
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("Base URL must start with http:// or https://".to_string());
    }
    Ok(trimmed.to_string())
}

fn api_error_message(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<ApiErrorBody>(body) {
        if let Some(message) = parsed.error.and_then(|e| e.message) {
            return format!("BusinessMap API error ({status}): {message}");
        }
    }
    format!("BusinessMap API error ({status}): {body}")
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}

fn generate_csrf_token() -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..20)
        .map(|_| {
            let idx = rng.gen_range(0..CHARS.len());
            CHARS[idx] as char
        })
        .collect()
}

pub fn parse_card_id(input: &str) -> Result<u64, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Card path is required".to_string());
    }

    if let Ok(id) = trimmed.parse::<u64>() {
        if id > 0 {
            return Ok(id);
        }
        return Err("Card ID must be a positive number".to_string());
    }

    let re = Regex::new(r"(?i)(?:^|/)cards/(\d+)(?:/|$|\?)")
        .map_err(|e| format!("Regex error: {e}"))?;
    re.captures(trimmed)
        .and_then(|caps| caps.get(1))
        .and_then(|m| m.as_str().parse::<u64>().ok())
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            "Could not parse card ID. Use ctrl_board/99/cards/402794/".to_string()
        })
}

pub fn parse_board_id(input: &str) -> Result<u64, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Card path is required".to_string());
    }

    let re = Regex::new(r"(?i)(?:^|/)ctrl_board/(\d+)(?:/|$|\?)")
        .map_err(|e| format!("Regex error: {e}"))?;
    re.captures(trimmed)
        .and_then(|caps| caps.get(1))
        .and_then(|m| m.as_str().parse::<u64>().ok())
        .filter(|id| *id > 0)
        .ok_or_else(|| "Board ID is required. Use ctrl_board/99/cards/402794/".to_string())
}

pub fn validate_card_path(input: &str) -> Result<(), String> {
    parse_board_id(input)?;
    parse_card_id(input)?;
    Ok(())
}

pub fn render_comment_template(template: &str, filename: &str) -> String {
    let trimmed = template.trim();
    if trimmed.is_empty() {
        return filename.to_string();
    }
    trimmed.replace("{filename}", filename)
}

pub fn test_connection(base_url: &str, api_key: &str) -> Result<String, String> {
    let base = normalize_base_url(base_url)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API key is required".to_string());
    }

    let client = http_client()?;
    let url = format!("{base}/api/v2/me");
    let response = client
        .get(&url)
        .header("apikey", api_key)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Connection failed: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|e| format!("Failed to read response: {e}"))?;

    if !status.is_success() {
        return Err(api_error_message(status, &body));
    }

    let parsed: MeResponse =
        serde_json::from_str(&body).map_err(|e| format!("Unexpected response format: {e}"))?;

    Ok(parsed
        .data
        .username
        .or(parsed.data.email)
        .unwrap_or_else(|| "Connected".to_string()))
}

pub fn upload_file(
    base_url: &str,
    api_key: &str,
    file_name: &str,
    bytes: &[u8],
    mime_type: &str,
) -> Result<String, String> {
    let base = normalize_base_url(base_url)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API key is required".to_string());
    }
    if file_name.trim().is_empty() {
        return Err("File name is required".to_string());
    }
    if bytes.is_empty() {
        return Err("File is empty".to_string());
    }

    let csrf = generate_csrf_token();
    let client = http_client()?;

    let part = reqwest::blocking::multipart::Part::bytes(bytes.to_vec())
        .file_name(file_name.to_string())
        .mime_str(mime_type)
        .map_err(|e| format!("Failed to prepare upload: {e}"))?;

    let form = reqwest::blocking::multipart::Form::new()
        .text("ci_csrf_token", csrf.clone())
        .part("files[]", part);

    let url = format!("{base}/files");
    let response = client
        .post(&url)
        .header("apikey", api_key)
        .header("Cookie", format!("ci_csrf_token={csrf}"))
        .multipart(form)
        .send()
        .map_err(|e| format!("File upload failed: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|e| format!("Failed to read upload response: {e}"))?;

    if !status.is_success() {
        return Err(api_error_message(status, &body));
    }

    let parsed: UploadResponse =
        serde_json::from_str(&body).map_err(|e| format!("Unexpected upload response: {e}"))?;

    let file_info = parsed
        .resparray
        .and_then(|items| items.into_iter().next())
        .ok_or_else(|| "Upload response did not include file data".to_string())?;

    if file_info.status.as_deref() != Some("success") {
        let name = file_info.file_name.unwrap_or_else(|| file_name.to_string());
        return Err(format!("Upload failed for {name}"));
    }

    file_info
        .link
        .filter(|link| !link.is_empty())
        .ok_or_else(|| "Upload succeeded but no file link was returned".to_string())
}

pub fn post_comment_with_attachments(
    base_url: &str,
    api_key: &str,
    card_id: u64,
    text: &str,
    attachments: &[(String, String)],
) -> Result<(), String> {
    let base = normalize_base_url(base_url)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API key is required".to_string());
    }
    if text.trim().is_empty() {
        return Err("Comment text cannot be empty".to_string());
    }
    if attachments.is_empty() {
        return Err("At least one attachment is required".to_string());
    }

    let client = http_client()?;
    let url = format!("{base}/api/v2/cards/{card_id}/comments");
    let payload = CommentCreateBody {
        text,
        attachments_to_add: attachments
            .iter()
            .map(|(file_name, link)| CommentAttachment {
                file_name: file_name.as_str(),
                link: link.as_str(),
            })
            .collect(),
    };

    let response = client
        .post(&url)
        .header("apikey", api_key)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .map_err(|e| format!("Failed to post comment: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|e| format!("Failed to read comment response: {e}"))?;

    if !status.is_success() {
        return Err(api_error_message(status, &body));
    }

    Ok(())
}

pub fn post_comment_with_attachment(
    base_url: &str,
    api_key: &str,
    card_id: u64,
    text: &str,
    file_name: &str,
    link: &str,
) -> Result<(), String> {
    post_comment_with_attachments(
        base_url,
        api_key,
        card_id,
        text,
        &[(file_name.to_string(), link.to_string())],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_card_id_from_url() {
        assert_eq!(
            parse_card_id("https://dasa.businessmap.io/ctrl_board/99/cards/402794/comments/").unwrap(),
            402794
        );
    }

    #[test]
    fn parse_card_id_from_path_requires_cards_segment() {
        assert_eq!(parse_card_id("ctrl_board/99/cards/402794/").unwrap(), 402794);
        assert_eq!(parse_card_id("cards/402794/").unwrap(), 402794);
    }

    #[test]
    fn validate_card_path_requires_board() {
        assert!(validate_card_path("ctrl_board/99/cards/402794/").is_ok());
        assert!(validate_card_path("cards/402794/").is_err());
    }

    #[test]
    fn parse_card_id_from_number() {
        assert_eq!(parse_card_id("402794").unwrap(), 402794);
    }

    #[test]
    fn render_comment_template_replaces_filename() {
        assert_eq!(
            render_comment_template("Evidence: {filename}", "clip.gif"),
            "Evidence: clip.gif"
        );
    }

    #[test]
    fn render_comment_template_supports_batch_filenames() {
        assert_eq!(
            render_comment_template("Evidence: {filename}", "a.gif, b.mp4"),
            "Evidence: a.gif, b.mp4"
        );
    }
}
