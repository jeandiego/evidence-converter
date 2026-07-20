# Evidence GIF Converter

Desktop app for converting `.mov` and `.mp4` files to GIFs. Built with Tauri, React, and TypeScript.

## For teammates (install)

Download the latest release for your platform from [GitHub Releases](../../releases):

- **macOS:** open the `.dmg`, drag the app to Applications
- **Windows:** run the `.msi` or `.exe` installer

No Homebrew, ffmpeg, or PATH setup required — ffmpeg is bundled inside the app.

## For developers

### Prerequisites

- [Bun](https://bun.sh)
- [Rust stable](https://rustup.rs)
- macOS: Xcode command line tools (`unzip` for the download script)
- Windows: PowerShell (used by the download script)

### Setup

```bash
bun install
```

### Development

Uses system ffmpeg from PATH when bundled sidecars are not present (e.g. before first download):

```bash
bun tauri dev
```

### Production build

Downloads platform-specific ffmpeg/ffprobe sidecars, then builds the installer:

```bash
bun run tauri:build
```

To fetch sidecars only:

```bash
bun run download-ffmpeg
```

Sidecar binaries are written to `src-tauri/binaries/` and are not committed to git.

### Releases (maintainers)

Push a version tag to trigger CI builds for macOS and Windows:

```bash
git tag v0.1.0
git push origin v0.1.0
```

CI uploads `.dmg`, `.app`, `.msi`, and `.exe` artifacts and attaches them to the GitHub Release.

## Third-party licenses

This app bundles [FFmpeg](https://ffmpeg.org/) via [@ffmpeg-installer](https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg) and [@ffprobe-installer](https://www.npmjs.com/package/@ffprobe-installer/ffprobe) for video conversion. FFmpeg is licensed under the GPL/LGPL depending on build; source is available from the FFmpeg project.
