import { createSqlDatabase, type SqlExecutor } from "./storage.js";
import type { CaptureMetadata, SqlQuery, SqlResult, StoredCapture, WorkerEnv, WorkerSecrets } from "./types.js";

export interface CloudflareBindings extends WorkerSecrets {
  DB: D1Database;
  ASSETS: Fetcher;
  BUCKET: R2Bucket;
}

class D1Executor implements SqlExecutor {
  public constructor(private readonly database: D1Database) {}

  public async first(query: SqlQuery): Promise<unknown | null> {
    return this.database.prepare(query.sql).bind(...query.args).first();
  }

  public async all(query: SqlQuery): Promise<readonly unknown[]> {
    const result = await this.database.prepare(query.sql).bind(...query.args).all();
    return result.results;
  }

  public async run(query: SqlQuery): Promise<SqlResult> {
    const result = await this.database.prepare(query.sql).bind(...query.args).run();
    return { rowsAffected: result.meta.changes };
  }

  public async batch(queries: readonly SqlQuery[]): Promise<SqlResult[]> {
    const statements = queries.map(({ sql, args }) => this.database.prepare(sql).bind(...args));
    const results = await this.database.batch(statements);
    return results.map((result) => ({ rowsAffected: result.meta.changes }));
  }
}

class R2CaptureStore {
  public constructor(private readonly bucket: R2Bucket) {}

  public async put(key: string, bytes: Uint8Array, metadata: CaptureMetadata): Promise<void> {
    await this.bucket.put(key, bytes, {
      httpMetadata: { contentType: metadata.contentType },
      customMetadata: { ...metadata.customMetadata },
    });
  }

  public async get(key: string): Promise<StoredCapture | null> {
    const object = await this.bucket.get(key);
    if (object === null) return null;
    return {
      size: object.size,
      customMetadata: object.customMetadata ?? null,
      arrayBuffer: () => object.arrayBuffer(),
    };
  }
}

export function createCloudflareWorkerEnv(bindings: CloudflareBindings): WorkerEnv {
  return {
    DB: createSqlDatabase(new D1Executor(bindings.DB)),
    CAPTURES: new R2CaptureStore(bindings.BUCKET),
    TYPESAFE_API_KEY: bindings.TYPESAFE_API_KEY,
    FINNHUB_API_KEY: bindings.FINNHUB_API_KEY,
    FINNHUB_PROCESSING_APPROVED: bindings.FINNHUB_PROCESSING_APPROVED,
    NEWSJACK_SEC_USER_AGENT: bindings.NEWSJACK_SEC_USER_AGENT,
    TYPESAFE_API_BASE_URL: bindings.TYPESAFE_API_BASE_URL,
  };
}
