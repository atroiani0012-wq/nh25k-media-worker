import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFromFiles } from "./lib.mjs";

const coreUrl = String(process.env.CAMPAIGN_CORE_URL ?? "").replace(/\/$/, "");
const maxJobs = Math.min(8, Math.max(1, Number(process.env.MAX_RENDER_JOBS ?? 4)));
if (!/^https:\/\//.test(coreUrl)) throw new Error("CAMPAIGN_CORE_URL must use HTTPS.");

const oidcAudience = "nh25k-campaign-core";
let cachedOidc = null;

function jwtExpiry(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return Number(JSON.parse(Buffer.from(payload, "base64").toString("utf8")).exp) * 1_000;
  } catch { return 0; }
}

async function githubOidcToken() {
  if (cachedOidc && cachedOidc.expiresAt > Date.now() + 60_000) return cachedOidc.value;
  const requestUrl = String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
  const requestToken = String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "");
  if (!requestUrl || !requestToken) throw new Error("GitHub Actions OIDC is unavailable.");
  const separator = requestUrl.includes("?") ? "&" : "?";
  const response = await fetch(`${requestUrl}${separator}audience=${encodeURIComponent(oidcAudience)}`, {
    headers: { authorization: `Bearer ${requestToken}`, accept: "application/json; api-version=2.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub OIDC request failed with HTTP ${response.status}.`);
  const body = await response.json();
  if (typeof body?.value !== "string") throw new Error("GitHub OIDC response is invalid.");
  cachedOidc = { value: body.value, expiresAt: jwtExpiry(body.value) };
  return body.value;
}

async function core(path, options = {}) {
  const token = await githubOidcToken();
  const response = await fetch(`${coreUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 204) return { status: 204, body: null };
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`Campaign Core ${path} failed with HTTP ${response.status}: ${String(body?.error ?? body).slice(0, 500)}`);
  return { status: response.status, body };
}

async function claim(kind) {
  const { status, body } = await core("/api/n8n/jobs/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaignId: "NH25K", jobKind: kind, leaseSeconds: 900 }),
  });
  return status === 204 ? null : body?.job ?? null;
}

async function complete(jobId, outcome, result, error) {
  const retryAfter = outcome === "RETRY" ? new Date(Date.now() + 5 * 60_000).toISOString() : undefined;
  await core(`/api/n8n/jobs/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outcome, result, error, retryAfter }),
  });
}

async function download(url, path) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Signed media download failed with HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 35 * 1024 * 1024) throw new Error("Signed media source is empty or too large.");
  await writeFile(path, bytes, { mode: 0o600 });
}

async function renderJob(job) {
  const payload = job.payload ?? {};
  if (typeof payload.contentId !== "string") throw new Error("Render job is missing contentId.");
  const { body: state } = await core("/api/n8n/content/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "GET", contentId: payload.contentId, campaignId: "NH25K" }),
  });
  if (!state?.assetUrls?.image || !state?.assetUrls?.audio) throw new Error("Render job requires signed image and audio URLs.");

  const directory = await mkdtemp(join(tmpdir(), "nh25k-github-media-"));
  const imagePath = join(directory, "source-image");
  const audioPath = join(directory, "source-audio");
  const outputPath = join(directory, "final.mp4");
  try {
    await Promise.all([download(state.assetUrls.image, imagePath), download(state.assetUrls.audio, audioPath)]);
    const validation = await renderFromFiles({ imagePath, audioPath, outputPath, mode: "NARRATED" });
    const output = await readFile(outputPath);
    const assetKey = `NH25K/content/${payload.contentId}/final-${validation.sha256.slice(0, 12)}.mp4`;
    const { body: stored } = await core("/api/n8n/media", {
      method: "POST",
      headers: { "content-type": "video/mp4", "content-length": String(output.byteLength), "x-asset-key": assetKey },
      body: output,
    });
    await core("/api/n8n/content/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "ATTACH_ASSET", contentId: payload.contentId, campaignId: "NH25K", assetType: "video", assetKey: stored.key, mimeType: "video/mp4", bytes: stored.bytes, sourceJobId: job.id, validation }),
    });
    await complete(job.id, "SUCCEEDED", { contentId: payload.contentId, assetKey: stored.key, validation }, undefined);
    console.log(`Validated final MP4 for ${payload.contentId}.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

let processed = 0;
for (; processed < maxJobs; processed += 1) {
  const job = await claim("SUBMIT_MEDIA_RENDER") ?? await claim("SUBMIT_VIDEO_RENDER");
  if (!job) break;
  try {
    await renderJob(job);
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 2_000);
    console.error(`Render ${job.id} failed: ${message}`);
    await complete(job.id, "RETRY", { worker: "github-actions", validatorVersion: "nh25k-media-v1" }, message);
  }
}
console.log(`Campaign Media Worker processed ${processed} job(s).`);
