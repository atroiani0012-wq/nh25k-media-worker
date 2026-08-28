import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

export const MEDIA_WORKER_VERSION = "nh25k-media-v1";
export const MAX_SOURCE_BYTES = 35 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

const allowedModes = new Set(["NARRATED", "SILENT_8S"]);

export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function isPrivateIp(value) {
  if (!isIP(value)) return false;
  if (value.includes(":")) {
    const normalized = value.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  const [a, b] = value.split(".").map(Number);
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function validateSourceUrl(value, allowedHosts) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("Media source URL is invalid."); }
  if (parsed.protocol !== "https:") throw new Error("Media source URL must use HTTPS.");
  if (parsed.username || parsed.password || parsed.port) throw new Error("Media source URL contains forbidden authority fields.");
  if (isPrivateIp(parsed.hostname)) throw new Error("Private-network media sources are forbidden.");
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) throw new Error(`Media source host is not allowlisted: ${parsed.hostname}`);
  return parsed.toString();
}

export function validateRenderRequest(value, allowedHosts) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Render request must be an object.");
  const unknown = Object.keys(value).filter((key) => !["contentId", "idempotencyKey", "imageUrl", "audioUrl", "mode"].includes(key));
  if (unknown.length) throw new Error(`Unknown render request field: ${unknown[0]}`);
  const contentId = String(value.contentId ?? "").trim();
  const idempotencyKey = String(value.idempotencyKey ?? "").trim();
  const mode = String(value.mode ?? "NARRATED");
  if (!/^[A-Za-z0-9:_-]{8,120}$/.test(contentId)) throw new Error("contentId is invalid.");
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) throw new Error("idempotencyKey is invalid.");
  if (!allowedModes.has(mode)) throw new Error("Render mode is invalid.");
  const imageUrl = validateSourceUrl(value.imageUrl, allowedHosts);
  const audioUrl = mode === "NARRATED" ? validateSourceUrl(value.audioUrl, allowedHosts) : null;
  return { contentId, idempotencyKey, imageUrl, audioUrl, mode };
}

export function buildFfmpegArgs({ imagePath, audioPath, outputPath, mode }) {
  const filter = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x0d2934,fps=30,format=yuv420p";
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", imagePath];
  if (mode === "NARRATED") args.push("-i", audioPath);
  args.push("-vf", filter, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart");
  if (mode === "NARRATED") args.push("-c:a", "aac", "-b:a", "128k", "-shortest");
  else args.push("-t", "8", "-an");
  args.push(outputPath);
  return args;
}

export function runProcess(command, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stderr });
      else reject(new Error(`${basename(command)} failed (${signal ?? code}): ${stderr.trim()}`));
    });
  });
}

export function validateProbe(probe, { bytes, sha256, mode }) {
  const formatNames = String(probe?.format?.format_name ?? "").split(",");
  const durationSeconds = Number(probe?.format?.duration);
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (!formatNames.includes("mp4")) throw new Error("Rendered file is not an MP4 container.");
  if (!video || video.codec_name !== "h264") throw new Error("Rendered video codec must be H.264.");
  if (video.width !== 1080 || video.height !== 1920) throw new Error("Rendered video must be exactly 1080x1920.");
  if (video.pix_fmt !== "yuv420p") throw new Error("Rendered pixel format must be yuv420p.");
  if (!Number.isFinite(durationSeconds) || durationSeconds < 2 || durationSeconds > 60) throw new Error("Rendered duration is outside the 2–60 second boundary.");
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_OUTPUT_BYTES) throw new Error("Rendered file size is outside the allowed boundary.");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Rendered file digest is invalid.");
  if (mode === "NARRATED" && (!audio || audio.codec_name !== "aac")) throw new Error("Narrated render must contain AAC audio.");
  if (mode === "SILENT_8S" && audio) throw new Error("Silent render must not contain an audio stream.");
  return {
    validated: true,
    validatorVersion: MEDIA_WORKER_VERSION,
    container: "mp4",
    videoCodec: "h264",
    audioCodec: audio?.codec_name ?? null,
    width: video.width,
    height: video.height,
    pixelFormat: video.pix_fmt,
    frameRate: String(video.avg_frame_rate ?? ""),
    durationSeconds: Number(durationSeconds.toFixed(3)),
    bytes,
    sha256,
    validatedAt: new Date().toISOString(),
  };
}

export async function probeAndValidate(outputPath, mode) {
  const { size: bytes } = await fs.stat(outputPath);
  const sha256 = createHash("sha256").update(await fs.readFile(outputPath)).digest("hex");
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", outputPath];
  const child = spawn("ffprobe", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  if (code !== 0) throw new Error(`ffprobe failed: ${stderr.trim()}`);
  return validateProbe(JSON.parse(stdout), { bytes, sha256, mode });
}

export async function renderFromFiles({ imagePath, audioPath, outputPath, mode }) {
  await runProcess("ffmpeg", buildFfmpegArgs({ imagePath, audioPath, outputPath, mode }));
  return probeAndValidate(outputPath, mode);
}

export async function downloadSource(url, destination, allowedHosts) {
  validateSourceUrl(url, allowedHosts);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(45_000) });
  if (!response.ok || !response.body) throw new Error(`Media download failed with HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_SOURCE_BYTES) throw new Error("Media source exceeds the maximum size.");
  const reader = response.body.getReader();
  const handle = await fs.open(destination, "wx", 0o600);
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_SOURCE_BYTES) throw new Error("Media source exceeds the maximum size.");
      await handle.write(value);
    }
  } finally {
    await handle.close();
  }
  return received;
}

export function newJobId() { return randomUUID(); }
export function jobDirectory(dataDir, id) { return join(dataDir, "jobs", id); }
