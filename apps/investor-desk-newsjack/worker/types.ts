export interface WorkerEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  BUCKET: R2Bucket;
  TYPESAFE_API_KEY?: string;
  FINNHUB_API_KEY?: string;
  FINNHUB_PROCESSING_APPROVED?: string;
  NEWSJACK_SEC_USER_AGENT?: string;
  TYPESAFE_API_BASE_URL?: string;
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
  public constructor(private readonly maximum = 45) {}

  public take(): void {
    this.used += 1;
    if (this.used > this.maximum) {
      throw new ProviderFailure("worker", "subrequest_budget", "This refresh reached its safe request limit. Continue with the next refresh slice.");
    }
  }

  public get count(): number {
    return this.used;
  }

  public get remaining(): number {
    return Math.max(0, this.maximum - this.used);
  }
}
