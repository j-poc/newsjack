import { z, type ZodType } from "zod";
import type { SqlDatabase, SqlInput, SqlQuery, SqlResult, SqlStatement } from "./types";

export interface SqlExecutor {
  first(query: SqlQuery): Promise<unknown | null>;
  all(query: SqlQuery): Promise<readonly unknown[]>;
  run(query: SqlQuery): Promise<SqlResult>;
  batch(queries: readonly SqlQuery[]): Promise<SqlResult[]>;
}

class PreparedStatement implements SqlStatement {
  public readonly query: SqlQuery;

  public constructor(private readonly executor: SqlExecutor, sql: string, args: readonly SqlInput[] = []) {
    this.query = { sql, args: [...args] };
  }

  public bind(...values: SqlInput[]): SqlStatement {
    return new PreparedStatement(this.executor, this.query.sql, values);
  }

  public isFor(executor: SqlExecutor): boolean {
    return this.executor === executor;
  }

  public async first<T>(schema: ZodType<T>): Promise<T | null> {
    const row = await this.executor.first(this.query);
    return row === null ? null : schema.parse(row);
  }

  public async all<T>(schema: ZodType<T>): Promise<T[]> {
    return z.array(schema).parse(await this.executor.all(this.query));
  }

  public run(): Promise<SqlResult> {
    return this.executor.run(this.query);
  }
}

class Database implements SqlDatabase {
  public constructor(private readonly executor: SqlExecutor) {}

  public prepare(sql: string): SqlStatement {
    return new PreparedStatement(this.executor, sql);
  }

  public batch(statements: readonly SqlStatement[]): Promise<SqlResult[]> {
    const queries = statements.map((statement) => {
      if (!(statement instanceof PreparedStatement) || !statement.isFor(this.executor)) {
        throw new Error("A SQL batch can contain only statements prepared by the same database adapter.");
      }
      return statement.query;
    });
    return this.executor.batch(queries);
  }
}

export function createSqlDatabase(executor: SqlExecutor): SqlDatabase {
  return new Database(executor);
}
