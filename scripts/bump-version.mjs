import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const VERSION_FILES = [
  {
    path: join(rootDir, "package.json"),
    read: (content) => JSON.parse(content).version,
    write: (content, version) => {
      const json = JSON.parse(content);
      json.version = version;
      return `${JSON.stringify(json, null, 2)}\n`;
    },
  },
  {
    path: join(rootDir, "src-tauri", "tauri.conf.json"),
    read: (content) => JSON.parse(content).version,
    write: (content, version) => {
      const json = JSON.parse(content);
      json.version = version;
      return `${JSON.stringify(json, null, 2)}\n`;
    },
  },
  {
    path: join(rootDir, "src-tauri", "Cargo.toml"),
    read: (content) => {
      const match = content.match(/^version = "(.+)"$/m);
      if (!match) {
        throw new Error("Could not find package version in Cargo.toml");
      }
      return match[1];
    },
    write: (content, version) =>
      content.replace(/^version = ".+"$/m, `version = "${version}"`),
  },
];

const SEMVER = /^\d+\.\d+\.\d+$/;

function parseArgs(argv) {
  const arg = argv[2];

  if (!arg || arg === "patch") {
    return { mode: "patch" };
  }
  if (arg === "minor" || arg === "major") {
    return { mode: arg };
  }
  if (SEMVER.test(arg)) {
    return { mode: "set", version: arg };
  }

  console.error(`Invalid version argument: ${arg}`);
  printUsage();
  process.exit(1);
}

function printUsage() {
  console.log(`Usage:
  bun run bump [patch|minor|major|<x.y.z>]

Examples:
  bun run bump           # 0.1.0 -> 0.1.1
  bun run bump minor     # 0.1.0 -> 0.2.0
  bun run bump 1.0.0     # set exact version`);
}

function bumpVersion(current, mode) {
  const [major, minor, patch] = current.split(".").map(Number);

  switch (mode) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unknown bump mode: ${mode}`);
  }
}

function readVersions() {
  const versions = VERSION_FILES.map(({ path, read, write }) => {
    const content = readFileSync(path, "utf8");
    return {
      path,
      read,
      write,
      content,
      version: read(content),
    };
  });

  const unique = [...new Set(versions.map(({ version }) => version))];
  if (unique.length !== 1) {
    console.error("Version mismatch across project files:");
    for (const { path, version } of versions) {
      console.error(`  ${path}: ${version}`);
    }
    process.exit(1);
  }

  return { current: unique[0], files: versions };
}

function main() {
  const { mode, version: explicitVersion } = parseArgs(process.argv);
  const { current, files } = readVersions();
  const next =
    mode === "set" ? explicitVersion : bumpVersion(current, mode);

  if (!SEMVER.test(next)) {
    console.error(`Invalid resulting version: ${next}`);
    process.exit(1);
  }

  if (next === current) {
    console.log(`Version already ${current}; nothing to do.`);
    return;
  }

  for (const file of files) {
    const updated = file.write(file.content, next);
    writeFileSync(file.path, updated, "utf8");
    console.log(`Updated ${file.path}`);
  }

  console.log(`\n${current} -> ${next}`);
  console.log(`
Next steps:
  git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
  git commit -m "chore: bump version to ${next}"
  git tag v${next}
  git push origin HEAD
  git push origin v${next}`);
}

main();
