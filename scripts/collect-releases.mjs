import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(rootDir, "dist", "releases");
const tauriConfig = JSON.parse(
  readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"),
);
const productName = tauriConfig.productName;
const version = tauriConfig.version;

const artifacts = [
  join(
    rootDir,
    `src-tauri/target/release/bundle/dmg/${productName}_${version}_aarch64.dmg`,
  ),
  join(
    rootDir,
    `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/${productName}_${version}_x64-setup.exe`,
  ),
];

mkdirSync(outDir, { recursive: true });

for (const source of artifacts) {
  try {
    const destination = join(outDir, source.split("/").at(-1));
    copyFileSync(source, destination);
    console.log(`Copied ${destination}`);
  } catch {
    // Ignore missing artifacts when collecting after a single-platform build.
  }
}
