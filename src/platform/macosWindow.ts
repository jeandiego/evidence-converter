import { type } from "@tauri-apps/plugin-os";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function isMacosPlatform(): boolean {
  if (document.documentElement.classList.contains("platform-macos")) {
    return true;
  }

  try {
    return type() === "macos";
  } catch {
    return /Mac/i.test(navigator.platform);
  }
}

export async function initMacosWindow(): Promise<boolean> {
  if (!isMacosPlatform()) {
    return false;
  }

  document.documentElement.classList.add("platform-macos");

  const window = getCurrentWindow();
  await window.onCloseRequested(async (event) => {
    event.preventDefault();
    await window.hide();
  });

  return true;
}

export async function hideMacosWindow(): Promise<void> {
  if (!isMacosPlatform()) {
    return;
  }

  await getCurrentWindow().hide();
}
