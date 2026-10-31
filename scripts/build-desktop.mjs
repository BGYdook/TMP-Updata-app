import path from "node:path";
import { spawnSync } from "node:child_process";

const binary = process.platform === "win32" ? "electron-builder.cmd" : "electron-builder";
const builder = path.join(process.cwd(), "node_modules", ".bin", binary);
const env = {
  ...process.env,
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

const obfuscation = spawnSync(
  process.execPath,
  [path.join(process.cwd(), "scripts", "obfuscate-release.mjs")],
  {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  },
);

if (obfuscation.error) throw obfuscation.error;
if (obfuscation.status !== 0) process.exit(obfuscation.status ?? 1);

const result = spawnSync(
  builder,
  ["--win", "nsis", "--config.electronDist=node_modules/electron/dist"],
  {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
