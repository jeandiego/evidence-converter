import { type } from "@tauri-apps/plugin-os";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type AppPlatform = "macos" | "windows" | "other";

function detectPlatform(): AppPlatform {
  if (document.documentElement.classList.contains("platform-macos")) {
    return "macos";
  }
  if (document.documentElement.classList.contains("platform-windows")) {
    return "windows";
  }

  try {
    const os = type();
    if (os === "macos") return "macos";
    if (os === "windows") return "windows";
  } catch {
    if (/Mac/i.test(navigator.platform)) return "macos";
    if (/Win/i.test(navigator.platform)) return "windows";
  }

  return "other";
}

export function getAppPlatform(): AppPlatform {
  return detectPlatform();
}

export function isMacosPlatform(): boolean {
  return detectPlatform() === "macos";
}

export function isWindowsPlatform(): boolean {
  return detectPlatform() === "windows";
}

function applyPlatformClass(platform: AppPlatform): void {
  const root = document.documentElement;
  root.classList.remove("platform-macos", "platform-windows");

  if (platform === "macos") {
    root.classList.add("platform-macos");
  } else if (platform === "windows") {
    root.classList.add("platform-windows");
  }
}

export async function initPlatformWindow(): Promise<AppPlatform> {
  const platform = detectPlatform();
  applyPlatformClass(platform);

  const window = getCurrentWindow();

  if (platform === "macos" || platform === "windows") {
    await window.onCloseRequested(async (event) => {
      event.preventDefault();
      await window.hide();
    });
  }

  return platform;
}

export async function hideAppWindow(): Promise<void> {
  await getCurrentWindow().hide();
}
