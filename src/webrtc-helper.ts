import * as crypto from "node:crypto";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPlatformConfigDir } from "./utils.ts";

const HELPER_VERSION = "0.2.0";

interface ManifestEntry {
  os: "linux" | "darwin" | "win32";
  arch: "aarch64" | "x86_64";
  url: string;
  sha256: string;
}

const MANIFEST: ManifestEntry[] = [
  {
    os: "darwin",
    arch: "aarch64",
    url: "https://storage.googleapis.com/gridspace-guava-cli/webrtc/0.2.0/guava-webrtc-darwin-aarch64",
    sha256: "4f42f9d75fe1b78b9e4f794a475d6d01d6f18c0865d65b4ad14368d28a7e0b95",
  },
  {
    os: "darwin",
    arch: "x86_64",
    url: "https://storage.googleapis.com/gridspace-guava-cli/webrtc/0.2.0/guava-webrtc-darwin-x86_64",
    sha256: "0532f8a895142d9e4331f4a5552aae15d82fa7652725fdce08c46ba643c147df",
  },
  {
    os: "linux",
    arch: "aarch64",
    url: "https://storage.googleapis.com/gridspace-guava-cli/webrtc/0.2.0/guava-webrtc-linux-aarch64",
    sha256: "0abaeb725a9c809474adbbe88ee0dc5e6866ebdec724fa87fb44be4433a2f386",
  },
  {
    os: "linux",
    arch: "x86_64",
    url: "https://storage.googleapis.com/gridspace-guava-cli/webrtc/0.2.0/guava-webrtc-linux-x86_64",
    sha256: "08dc989beb09058185f93e7f5dd4d92a4fb54419f7ba88be17dbaa6e5649ba4b",
  },
  {
    os: "win32",
    arch: "x86_64",
    url: "https://storage.googleapis.com/gridspace-guava-cli/webrtc/0.2.0/guava-webrtc-windows-x86_64.exe",
    sha256: "3bef8753605a2b84f2c33f4b9760dc084e1cc12f55b886a2a2983e061f4c30bb",
  },
];

function detectArch(): "aarch64" | "x86_64" {
  const arch = os.arch();
  if (arch === "arm64") return "aarch64";
  if (arch === "x64") return "x86_64";
  throw new Error(`Unsupported architecture for WebRTC helper: ${arch}`);
}

async function downloadAndCheck(url: string, destination: string, sha256: string): Promise<void> {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guava-webrtc-"));
  const tmpFile = path.join(tmpDir, path.basename(destination));

  try {
    // biome-ignore lint: intentional use of fetch for binary download
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} downloading WebRTC helper`);
    if (!response.body) throw new Error("No response body");

    const hasher = crypto.createHash("sha256");
    const fileStream = fs.createWriteStream(tmpFile);
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      await new Promise<void>((resolve, reject) => {
        fileStream.write(value, (err) => (err ? reject(err) : resolve()));
      });
    }

    await new Promise<void>((resolve, reject) => {
      fileStream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });

    const actual = hasher.digest("hex");
    if (actual !== sha256) {
      throw new Error(`SHA-256 mismatch: expected ${sha256}, got ${actual}`);
    }

    fs.copyFileSync(tmpFile, destination);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function getOrDownloadBinary(): Promise<string> {
  const arch = detectArch();
  const currentOs = process.platform as "linux" | "darwin" | "win32";

  const entry = MANIFEST.find((e) => e.os === currentOs && e.arch === arch);
  if (!entry) {
    throw new Error(`No WebRTC helper binary available for ${currentOs}/${arch}`);
  }

  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const binaryPath = path.join(
    getPlatformConfigDir(),
    "guava",
    "webrtc",
    `guava-webrtc-${HELPER_VERSION}${exeSuffix}`,
  );

  if (!fs.existsSync(binaryPath)) {
    await downloadAndCheck(entry.url, binaryPath, entry.sha256);
    if (process.platform !== "win32") {
      const mode = fs.statSync(binaryPath).mode;
      fs.chmodSync(binaryPath, mode | 0o111);
    }
  }

  return binaryPath;
}

export async function runWebrtcHelper(webrtcCode: string, baseUrl: string): Promise<void> {
  const binaryPath = await getOrDownloadBinary();

  return new Promise<void>((resolve, reject) => {
    const proc = cp.spawn(binaryPath, [webrtcCode, "--base-url", baseUrl], { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`WebRTC helper exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}
