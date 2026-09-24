import type { ZodType } from "zod";

export type SqlInput = string | number | bigint | boolean | Uint8Array | ArrayBuffer | Date | null;

export interface SqlQuery {
  sql: string;
  args: readonly SqlInput[];
}

export interface SqlResult {
  rowsAffected: number;
}

export interface SqlStatement {
  readonly query: SqlQuery;
  bind(...values: SqlInput[]): SqlStatement;
  first<T>(schema: ZodType<T>): Promise<T | null>;
  all<T>(schema: ZodType<T>): Promise<T[]>;
  run(): Promise<SqlResult>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  batch(statements: readonly SqlStatement[]): Promise<SqlResult[]>;
}

export interface CaptureMetadata {
  contentType: string;
  customMetadata: Readonly<Record<string, string>>;
}

export interface StoredCapture {
  size: number;
  customMetadata: Readonly<Record<string, string>> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface CaptureStore {
  put(key: string, bytes: Uint8Array, metadata: CaptureMetadata): Promise<void>;
  get(key: string): Promise<StoredCapture | null>;
}

export interface WorkerSecrets {
  TYPESAFE_API_KEY?: string;
  FINNHUB_API_KEY?: string;
  FINNHUB_PROCESSING_APPROVED?: string;
  NEWSJACK_SEC_USER_AGENT?: string;
  TYPESAFE_API_BASE_URL?: string;
}

export interface WorkerEnv extends WorkerSecrets {
  DB: SqlDatabase;
  CAPTURES: CaptureStore;
  REQUEST_BUDGET_MS?: number;
}

export interface CaptureRecord {
  ownerId: string;
  provider: string;
  nativeId: string;
  sha256: string;
  objectKey: string;
  sourceUrl: string;
  contentType: string;
  byteLength: number;
  observedAt: string;
  adapterVersion: string;
}

export class ProviderFailure extends Error {
  public constructor(
    public readonly provider: string,
    public readonly stage: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderFailure";
  }
}

export class RequestBudget {
  private used = 0;
  private readonly startedAt = Date.now();
  private readonly persistenceReserveMs: number;

  public constructor(private readonly maximum = 45, private readonly durationMs?: number) {
    this.persistenceReserveMs = durationMs === undefined ? 0 : Math.min(10_000, Math.floor(durationMs / 4));
  }

  public take(): void {
    if (this.used >= this.maximum) {
      throw new ProviderFailure("worker", "subrequest_budget", "This refresh reached its safe request limit. Continue with the next refresh slice.");
    }
    if (this.remainingMs() <= this.persistenceReserveMs + 1_000) {
      throw new ProviderFailure("worker", "subrequest_budget", "This refresh reached its safe time limit. Continue with the next refresh slice.");
    }
    this.used += 1;
  }

  public timeoutMs(maximum = 25_000): number {
    if (this.durationMs === undefined) return maximum;
    return Math.max(1, Math.min(maximum, this.remainingMs() - this.persistenceReserveMs));
  }

  public get count(): number {
    return this.used;
  }

  public get remaining(): number {
    return Math.max(0, this.maximum - this.used);
  }

  private remainingMs(): number {
    return this.durationMs === undefined ? Number.POSITIVE_INFINITY : this.durationMs - (Date.now() - this.startedAt);
  }
}
