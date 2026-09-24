import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Client, InValue } from "@libsql/client";
import { z } from "zod";
import { createSqlDatabase, type SqlExecutor } from "./storage";
import type { CaptureMetadata, CaptureStore, SqlInput, SqlQuery, SqlResult, StoredCapture, WorkerEnv, WorkerSecrets } from "./types";

const MAX_CAPTURE_BYTES = 12 * 1024 * 1024;
const MAX_STORED_CAPTURE_BYTES = 3 * 1024 * 1024;
const StoredObjectSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  original_bytes: z.number().int().nonnegative(),
  content_type: z.string().min(1).max(200),
  custom_metadata_json: z.string(),
  encoding: z.literal("gzip"),
  stored_bytes: z.number().int().nonnegative(),
  body: z.union([z.instanceof(Uint8Array), z.instanceof(ArrayBuffer)])
    .transform((value) => value instanceof Uint8Array ? value : new Uint8Array(value)),
}).transform((value) => ({ ...value, body: Uint8Array.from(value.body) }));

class LibsqlExecutor implements SqlExecutor {
  public constructor(private readonly client: Client) {}

  public async first(query: SqlQuery): Promise<unknown | null> {
    const result = await this.client.execute({ sql: query.sql, args: asInValues(query.args) });
    return result.rows[0] ?? null;
  }

  public async all(query: SqlQuery): Promise<readonly unknown[]> {
    const result = await this.client.execute({ sql: query.sql, args: asInValues(query.args) });
    return result.rows;
  }

  public async run(query: SqlQuery): Promise<SqlResult> {
    const result = await this.client.execute({ sql: query.sql, args: asInValues(query.args) });
    return { rowsAffected: result.rowsAffected };
  }

  public async batch(queries: readonly SqlQuery[]): Promise<SqlResult[]> {
    if (queries.length === 0) return [];
    const results = await this.client.batch(
      queries.map((query) => ({ sql: query.sql, args: asInValues(query.args) })),
      "write",
    );
    return results.map((result) => ({ rowsAffected: result.rowsAffected }));
  }
}

class TursoCaptureStore implements CaptureStore {
  public constructor(private readonly client: Client) {}

  public async put(key: string, bytes: Uint8Array, metadata: CaptureMetadata): Promise<void> {
    if (key.length < 1 || key.length > 512 || bytes.byteLength > MAX_CAPTURE_BYTES) {
      throw new Error("Captured source exceeded the durable object key or raw body limit.");
    }
    const sha256 = metadata.customMetadata.sha256;
    if (sha256 === undefined || !/^[a-f0-9]{64}$/.test(sha256)
      || metadata.contentType.length < 1 || metadata.contentType.length > 200) {
      throw new Error("Captured source metadata failed storage validation.");
    }
    const customMetadataJson = JSON.stringify(metadata.customMetadata);
    if (customMetadataJson.length > 4_096) throw new Error("Captured source metadata exceeded its bounded storage limit.");
    const compressed = gzipSync(bytes, { level: 6 });
    if (compressed.byteLength > MAX_STORED_CAPTURE_BYTES) {
      throw new Error("Captured source is larger than the private database evidence limit; it was not truncated or advanced.");
    }

    await this.client.execute({
      sql: `INSERT INTO source_capture_objects (
        object_key, sha256, original_bytes, content_type, custom_metadata_json, encoding, stored_bytes, body, created_at
      ) VALUES (?, ?, ?, ?, ?, 'gzip', ?, ?, ?)
      ON CONFLICT(object_key) DO NOTHING`,
      args: [key, sha256, bytes.byteLength, metadata.contentType, customMetadataJson, compressed.byteLength, compressed, new Date().toISOString()],
    });

    const existing = await this.client.execute({
      sql: `SELECT sha256, original_bytes, content_type, custom_metadata_json, encoding, stored_bytes, body
        FROM source_capture_objects WHERE object_key = ? LIMIT 1`,
      args: [key],
    });
    const row = StoredObjectSchema.parse(existing.rows[0]);
    if (row.sha256 !== sha256 || row.original_bytes !== bytes.byteLength || row.content_type !== metadata.contentType
      || row.custom_metadata_json !== customMetadataJson || row.stored_bytes !== row.body.byteLength) {
      throw new Error("An immutable evidence key already exists with different capture metadata.");
    }
  }

  public async get(key: string): Promise<StoredCapture | null> {
    const result = await this.client.execute({
      sql: `SELECT sha256, original_bytes, content_type, custom_metadata_json, encoding, stored_bytes, body
        FROM source_capture_objects WHERE object_key = ? LIMIT 1`,
      args: [key],
    });
    if (result.rows.length === 0) return null;
    const row = StoredObjectSchema.parse(result.rows[0]);
    if (row.original_bytes > MAX_CAPTURE_BYTES || row.stored_bytes > MAX_STORED_CAPTURE_BYTES
      || row.stored_bytes !== row.body.byteLength) {
      throw new Error("Stored source evidence exceeded its recorded size bounds.");
    }
    const customMetadata = z.record(z.string(), z.string()).parse(JSON.parse(row.custom_metadata_json));
    if (customMetadata.sha256 !== row.sha256) throw new Error("Stored source evidence digest metadata is inconsistent.");
    const bytes = gunzipSync(row.body, { maxOutputLength: MAX_CAPTURE_BYTES });
    if (bytes.byteLength !== row.original_bytes || createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
      throw new Error("Stored source evidence failed its decompression or SHA-256 integrity check.");
    }
    const copy = Uint8Array.from(bytes);
    return {
      size: copy.byteLength,
      customMetadata,
      arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
    };
  }
}

export interface TursoBindings extends WorkerSecrets {
  client: Client;
  requestBudgetMs?: number;
}

export function createTursoWorkerEnv(bindings: TursoBindings): WorkerEnv {
  return {
    DB: createSqlDatabase(new LibsqlExecutor(bindings.client)),
    CAPTURES: new TursoCaptureStore(bindings.client),
    TYPESAFE_API_KEY: bindings.TYPESAFE_API_KEY,
    NEWSJACK_SEC_USER_AGENT: bindings.NEWSJACK_SEC_USER_AGENT,
    REQUEST_BUDGET_MS: bindings.requestBudgetMs,
  };
}

function asInValues(args: readonly SqlInput[]): InValue[] {
  return args.map((value) => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return value;
  });
}
