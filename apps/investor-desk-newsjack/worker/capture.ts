import { ProviderFailure, type CaptureRecord, type WorkerEnv, type RequestBudget } from "./types";

const MAX_RAW_BYTES = 12 * 1024 * 1024;
const ADAPTER_VERSION = "newsjack-worker-1";

export interface CapturedBody {
  bytes: Uint8Array;
  text: string;
  contentType: string;
  observedAt: string;
  capture: CaptureRecord;
  status: number;
}

export async function fetchCaptured(
  env: WorkerEnv,
  ownerId: string,
  provider: string,
  nativeId: string,
  input: string,
  init: RequestInit,
  budget: RequestBudget,
  redactedValues: readonly string[] = [],
  beforeRequest?: () => Promise<void>,
): Promise<CapturedBody> {
  const safeUrl = redactUrl(input);
  try {
    await beforeRequest?.();
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure("worker", "refresh_guard_unavailable", "The refresh ownership check could not be completed; provider work was not started.");
  }
  budget.take();
  let response: Response;
  try {
    response = await fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(25_000) });
  } catch {
    throw new ProviderFailure(provider, "network", `${providerLabel(provider)} could not be reached.`);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBounded(response);
  } catch (error) {
    throw new ProviderFailure(provider, "capture", error instanceof Error ? error.message : "Provider response exceeded the capture limit.", response.status);
  }
  const originalText = new TextDecoder().decode(bytes);
  let redactedText = originalText;
  for (const secret of redactedValues) {
    if (secret.length >= 8) redactedText = redactedText.replaceAll(secret, "[REDACTED]");
  }
  bytes = new TextEncoder().encode(redactedText);
  const sha256 = await digestHex(bytes);
  const observedAt = new Date().toISOString();
  const contentType = response.headers.get("content-type")?.slice(0, 200) ?? "application/octet-stream";
  const ownerHash = await digestHex(new TextEncoder().encode(ownerId));
  const nativeHash = await digestHex(new TextEncoder().encode(nativeId));
  const objectKey = `raw/${ownerHash}/${provider}/${nativeHash}/${sha256}.bin`;

  try {
    await env.BUCKET.put(objectKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: { provider, nativeHash, sha256, observedAt, adapterVersion: ADAPTER_VERSION },
    });
  } catch {
    throw new ProviderFailure(provider, "capture", `${providerLabel(provider)} responded, but its private evidence capture could not be retained. This batch was not advanced.`, response.status);
  }

  const capture: CaptureRecord = {
    ownerId,
    provider,
    nativeId,
    sha256,
    objectKey,
    sourceUrl: safeUrl,
    contentType,
    byteLength: bytes.byteLength,
    observedAt,
    adapterVersion: ADAPTER_VERSION,
  };

  if (!response.ok) {
    const message = `${providerLabel(provider)} returned HTTP ${response.status}.`;
    throw new CapturedProviderFailure(provider, "http", message, response.status, capture);
  }

  return { bytes, text: redactedText, contentType, observedAt, capture, status: response.status };
}

export async function readCaptured(env: WorkerEnv, ownerId: string, capture: CaptureRecord): Promise<CapturedBody> {
  if (capture.ownerId !== ownerId || capture.provider !== "sec" || !/^[a-f0-9]{64}$/.test(capture.sha256)) {
    throw new ProviderFailure("sec", "replay_identity", "The SEC discovery replay identity failed validation.");
  }
  const ownerHash = await digestHex(new TextEncoder().encode(ownerId));
  const nativeHash = await digestHex(new TextEncoder().encode(capture.nativeId));
  const expectedKey = `raw/${ownerHash}/sec/${nativeHash}/${capture.sha256}.bin`;
  if (capture.objectKey !== expectedKey) {
    throw new ProviderFailure("sec", "replay_identity", "The SEC discovery replay points outside its owner-scoped capture.");
  }

  let object: R2ObjectBody | null;
  try {
    object = await env.BUCKET.get(capture.objectKey);
  } catch {
    throw new ProviderFailure("sec", "replay_capture_unavailable", "The retained SEC discovery response could not be read.");
  }
  if (object === null) {
    throw new ProviderFailure("sec", "replay_capture_missing", "The retained SEC discovery response is missing; the issuer cursor remains held for recovery.");
  }
  if (object.size > MAX_RAW_BYTES || object.size !== capture.byteLength) {
    throw new ProviderFailure("sec", "replay_capture_invalid", "The retained SEC discovery response has an unexpected size.");
  }
  const metadata = object.customMetadata;
  if (metadata?.provider !== "sec" || metadata.sha256 !== capture.sha256) {
    throw new ProviderFailure("sec", "replay_capture_invalid", "The retained SEC discovery response metadata does not match its durable pointer.");
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await object.arrayBuffer());
  } catch {
    throw new ProviderFailure("sec", "replay_capture_unavailable", "The retained SEC discovery response could not be read completely.");
  }
  if (await digestHex(bytes) !== capture.sha256) {
    throw new ProviderFailure("sec", "replay_capture_digest", "The retained SEC discovery response failed its SHA-256 check.");
  }
  const text = new TextDecoder().decode(bytes);
  return {
    bytes,
    text,
    contentType: capture.contentType,
    observedAt: capture.observedAt,
    capture,
    status: 200,
  };
}

export class CapturedProviderFailure extends ProviderFailure {
  public constructor(provider: string, stage: string, message: string, status: number, public readonly capture: CaptureRecord) {
    super(provider, stage, message, status);
    this.name = "CapturedProviderFailure";
  }
}

export async function parseJson<T>(body: CapturedBody, provider: string): Promise<T> {
  try {
    return JSON.parse(body.text) as T;
  } catch {
    throw new ProviderFailure(provider, "parse", `${providerLabel(provider)} returned malformed JSON.`);
  }
}

export async function digestHex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RAW_BYTES) throw new Error("Provider response exceeded the 12 MiB capture limit.");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RAW_BYTES) {
        await reader.cancel();
        throw new Error("Provider response exceeded the 12 MiB capture limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    for (const key of ["token", "api_key", "apikey", "key"]) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return "https://invalid.local/redacted";
  }
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "sec": return "SEC EDGAR";
    case "federal_register": return "Federal Register";
    case "finnhub_news": return "Finnhub company news";
    case "typesafe_ai": return "TypeSafe AI";
    default: return "The provider";
  }
}
