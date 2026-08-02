# Evidence Converter

A desktop productivity tool for converting development evidence and publishing it directly to BusinessMap cards.

It was created to remove a recurring workflow bottleneck: screen recordings captured as `.mov` or `.mp4` often needed to be manually converted before they could be viewed inline in delivery cards or pull requests.

Evidence Converter turns that multi-step process into a single workflow:

1. Drop screenshots or recordings into the app.
2. Convert and optimize the files.
3. Publish them to a BusinessMap card or save them locally.

Built with Tauri, React, TypeScript, Rust, and FFmpeg. Release builds bundle FFmpeg, so teammates can install and use the app without configuring external dependencies.

| Convertion | Preferences |
| ---------- | ----------- |
| ![Evidence Converter on macOS](docs/convert-tab.png) | ![Evidence Converter on macOS](docs/preferences-tab.png) |

## Why I built it

I built this tool to make it easier to attach evidence to **BusinessMap** cards and **Azure DevOps pull requests**. A recurring part of my workflow was capturing many screenshots and screen recordings — and whenever a video was `.mov` or `.mp4`, I still had to convert it to GIF so it would render inline in BusinessMap comments instead of forcing people to download and open a file.

On macOS the app lives in the **menu bar**. Drop your files, and it converts and posts to BusinessMap in one step. You can also **save locally** when you only need the GIF for another purpose (for example, pasting into an Azure PR description).

## What this project demonstrates

- Identifying and automating a recurring developer workflow
- Building and distributing a cross-platform desktop application
- Integrating with an external REST API for file uploads and card comments
- Managing native processes and bundled FFmpeg sidecars through Tauri
- Designing batch-processing, progress, error, and persistence flows
- Automating macOS and Windows releases through GitHub Actions
- Human-directed, AI-assisted product and software development

## Product highlights

Evidence Converter is a productivity tool for QA, support, and engineering workflows where you capture `.mov` or `.mp4` screen recordings and need a small, shareable GIF quickly.

**Convert tab**

- **Save locally** — batch-convert videos to GIF, MP4, MOV, or WEBM in a folder you choose (handy for Azure PR descriptions and other tools).
- **Post to BusinessMap** — convert videos (or upload `.jpg` / `.png` images as-is) and attach them as **one comment** on a specific card per batch.
- Choose output format per video in the queue (GIF default; MOV, MP4, WEBM also supported).
- Board ID is remembered between sessions; card ID clears after each batch so the next upload targets the right card.
- Drag and drop files, or use **Add files…** to build a queue.
- Watch per-file progress while FFmpeg runs; clear or remove items before converting.
- Videos at 25 MB or larger are re-encoded automatically to reduce size while keeping reasonable quality.

**Preferences tab**

- Tune GIF output: **FPS** (1–30), **width** (height scales automatically), and **palette size** (2–256 colors).
- Configure BusinessMap: base URL, API key (from *My Account → API*), and a comment template (`{filename}` placeholder supported).
- **Test connection** verifies your API key before you post.

## Usage

1. **Launch the app** — it lives in the menu bar (macOS) or system tray (Windows). Click the icon to open the panel; right-click (or Ctrl+click on macOS) for **Quit**.
2. **Choose a destination**
   - *Save locally*: pick an output folder, then add `.mov` / `.mp4` files.
   - *Post to BusinessMap*: enter **board** and **card** IDs separately (e.g. board `99`, card `402794`). Board ID is saved for next time. Paste a full BusinessMap card URL into either field if you prefer — the app fills both IDs.
3. **Add files** via drag-and-drop or **Add files…**.
4. Click **Convert** (or **Convert & post** / **Post** when targeting BusinessMap).
5. After a successful BusinessMap upload, use **Open card comments in browser** to jump to the card.

Default GIF settings are 10 fps, 480 px width, and 128 colors. Adjust them in **Preferences** to match your evidence quality vs. file size needs.

## Supported formats

| Destination | Input formats | Video output |
|-------------|---------------|--------------|
| Save locally | `.mov`, `.mp4` | GIF (default), MP4, MOV, or WEBM per file |
| Post to BusinessMap | `.mov`, `.mp4`, `.jpg`, `.jpeg`, `.png` | GIF (default), MP4, MOV, or WEBM per video; images uploaded as-is |

Each batch posts a **single BusinessMap comment** with all attachments from that run. The comment template `{filename}` lists every file name in the batch.

## Installation

Download the latest installers from **[GitHub Releases](../../releases)** — same pattern as projects like [Reactotron](https://github.com/infinitered/reactotron/releases). Pick the asset for your platform under **Assets**. No Homebrew, ffmpeg, or PATH setup required.

| Platform | Asset | Install |
|----------|-------|---------|
| **macOS** (Apple Silicon) | `evidence-cvt_*_aarch64.dmg` | Open the DMG, drag the app to Applications |
| **Windows** | `evidence-cvt_*_x64-setup.exe` | Run the NSIS installer |

The app runs from the menu bar / tray and does not appear in the Dock on macOS.

### macOS: “app is damaged” message

If macOS blocks the app after install, remove the download quarantine flag and open it again:

```bash
xattr -cr "/Applications/Evidence Converter.app"
```

### Publishing a release

1. Bump the version (updates `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`):

```bash
bun run bump          # patch: 0.1.0 -> 0.1.1
bun run bump minor    # 0.1.0 -> 0.2.0
bun run bump 1.0.0    # set exact version
```

2. Commit, tag, and push (the bump script prints the exact commands).

3. GitHub Actions builds macOS and Windows installers and attaches them to the release (workflow: `.github/workflows/release.yml`).

You can also trigger a build manually from the **Actions** tab → **Release** → **Run workflow**.

## Development

Requires [Bun](https://bun.sh/) and Rust (for Tauri).

```bash
bun install
bun tauri dev
```

In dev mode, the app uses bundled FFmpeg sidecars when present; otherwise it falls back to `ffmpeg` / `ffprobe` on your `PATH`.

Fetch sidecars only:

```bash
bun run download-ffmpeg:mac
bun run download-ffmpeg:windows
bun run download-ffmpeg:all
```

Sidecar binaries live in `src-tauri/binaries/` and are not committed to git.

## Local release builds

### macOS `.dmg`

```bash
bun install
bun run tauri:build:mac
```

Output: `src-tauri/target/release/bundle/dmg/evidence-cvt_0.1.0_aarch64.dmg`

### Windows `.exe` from macOS (cross-compile)

MSI installers require a Windows machine (WiX). From macOS you can build the NSIS `.exe` installer instead.

One-time setup:

```bash
brew install nsis llvm
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
```

Build:

```bash
bun run tauri:build:windows
```

Output: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/evidence-cvt_*_x64-setup.exe`

Build both platforms:

```bash
bun run tauri:build:all
```

Ready-to-share copies are also written to `dist/releases/` when you run the build commands above.

## Tech stack

- **UI**: React 19, TypeScript, Vite
- **Shell**: Tauri 2 (Rust)
- **Video**: FFmpeg / FFprobe (bundled via sidecars in release builds)
- **Integrations**: BusinessMap REST API (file upload + card comments)
- **Persistence**: Tauri Store plugin (output folder, FFmpeg settings, API key)

## AI-assisted development

This project was built through an AI-assisted, human-in-the-loop engineering workflow.

AI tools supported product exploration, implementation, debugging, documentation, and release automation. Product decisions, architecture, integration design, testing, validation, and final quality remained under human ownership.

## Third-party licenses

This app bundles [FFmpeg](https://ffmpeg.org/) via [@ffmpeg-installer](https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg) and [@ffprobe-installer](https://www.npmjs.com/package/@ffprobe-installer/ffprobe) for video conversion. FFmpeg is licensed under the GPL/LGPL depending on build; source is available from the FFmpeg project.
