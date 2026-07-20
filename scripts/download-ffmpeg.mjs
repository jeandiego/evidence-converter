import { execSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const binariesDir = join(rootDir, "src-tauri", "binaries");

const TARGETS = {
  "aarch64-apple-darwin": {
    ffmpegPackage: "@ffmpeg-installer/darwin-arm64",
    ffprobePackage: "@ffprobe-installer/darwin-arm64",
    ext: "",
  },
  "x86_64-apple-darwin": {
    ffmpegPackage: "@ffmpeg-installer/darwin-x64",
    ffprobePackage: "@ffprobe-installer/darwin-x64",
    ext: "",
  },
  "x86_64-pc-windows-msvc": {
    ffmpegPackage: "@ffmpeg-installer/win32-x64",
    ffprobePackage: "@ffprobe-installer/win32-x64",
    ext: ".exe",
  },
};

function hostTargetTriple() {
  return execSync("rustc --print host-tuple", { encoding: "utf8" }).trim();
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function run(command, cwd = rootDir) {
  execSync(command, { cwd, stdio: "inherit" });
}

function extractTarball(tarballPath, destinationDir) {
  ensureDir(destinationDir);
  run(`tar -xzf "${tarballPath}" -C "${destinationDir}"`);
}

function findFileRecursive(root, fileName) {
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.name === fileName) {
        return fullPath;
      }
    }
  }

  throw new Error(`Could not find ${fileName} in ${root}`);
}

function installPackageTool(packageName, toolName, destination) {
  const cacheDir = join(rootDir, ".cache", "ffmpeg", packageName.replace(/[@/]/g, "_"));
  ensureDir(cacheDir);

  for (const entry of readdirSync(cacheDir)) {
    if (entry.endsWith(".tgz")) {
      rmSync(join(cacheDir, entry));
    }
  }

  run(`npm pack "${packageName}"`, cacheDir);
  const tarball = readdirSync(cacheDir).find((entry) => entry.endsWith(".tgz"));

  if (!tarball) {
    throw new Error(`Failed to download npm package ${packageName}`);
  }

  const extractDir = join(cacheDir, "extracted");
  rmSync(extractDir, { recursive: true, force: true });
  extractTarball(join(cacheDir, tarball), extractDir);

  const source = findFileRecursive(extractDir, toolName);
  copyFileSync(source, destination);

  if (process.platform !== "win32") {
    chmodSync(destination, 0o755);
  }
}

function installTarget(targetTriple) {
  const config = TARGETS[targetTriple];
  if (!config) {
    throw new Error(`Unsupported target triple: ${targetTriple}`);
  }

  ensureDir(binariesDir);

  const ffmpegDest = join(binariesDir, `ffmpeg-${targetTriple}${config.ext}`);
  const ffprobeDest = join(binariesDir, `ffprobe-${targetTriple}${config.ext}`);

  console.log(`Installing ffmpeg sidecars for ${targetTriple}...`);
  installPackageTool(config.ffmpegPackage, config.ext ? "ffmpeg.exe" : "ffmpeg", ffmpegDest);
  installPackageTool(config.ffprobePackage, config.ext ? "ffprobe.exe" : "ffprobe", ffprobeDest);

  console.log(`Installed ${ffmpegDest}`);
  console.log(`Installed ${ffprobeDest}`);
}

function main() {
  const allTargets = process.argv.includes("--all-targets");
  const targets = allTargets ? Object.keys(TARGETS) : [hostTargetTriple()];

  if (!allTargets && !TARGETS[targets[0]]) {
    throw new Error(
      `Unsupported host target triple: ${targets[0]}. Supported: ${Object.keys(TARGETS).join(", ")}`,
    );
  }

  for (const targetTriple of targets) {
    installTarget(targetTriple);
  }
}

main();
