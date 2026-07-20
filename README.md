# Evidence GIF Converter

Desktop app for converting `.mov` and `.mp4` files to GIFs. Built with Tauri, React, and TypeScript.

## For teammates (install)

Share the built installers directly — no Homebrew, ffmpeg, or PATH setup required.

- **macOS:** open `evidence-cvt_*_aarch64.dmg`, drag the app to Applications
- **Windows:** run the `evidence-cvt_*_x64-setup.exe` NSIS installer

## Local release builds (maintainers)

### macOS `.dmg`

```bash
bun install
bun run tauri:build:mac
```

Output:

- `src-tauri/target/release/bundle/dmg/evidence-cvt_0.1.0_aarch64.dmg`

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

Output:

- `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/evidence-cvt_*_x64-setup.exe`

Build both platforms:

```bash
bun run tauri:build:all
```

Ready-to-share copies are also written to `dist/releases/` when you run the build commands above.

### Development

Uses system ffmpeg from PATH when bundled sidecars are missing:

```bash
bun tauri dev
```

Fetch sidecars only:

```bash
bun run download-ffmpeg:mac
bun run download-ffmpeg:windows
bun run download-ffmpeg:all
```

Sidecar binaries live in `src-tauri/binaries/` and are not committed to git.

## Third-party licenses

This app bundles [FFmpeg](https://ffmpeg.org/) via [@ffmpeg-installer](https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg) and [@ffprobe-installer](https://www.npmjs.com/package/@ffprobe-installer/ffprobe) for video conversion. FFmpeg is licensed under the GPL/LGPL depending on build; source is available from the FFmpeg project.
