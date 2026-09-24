import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";

interface Migration {
  name: string;
  checksum: string;
  statements: string[];
}

export async function applyTursoMigrations(client: Client, migrationDirectory: string): Promise<number> {
  const files = (await readdir(migrationDirectory)).filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(name)).sort();
  if (files.length === 0) throw new Error("No versioned Newsjack SQL migrations were packaged.");
  const migrations: Migration[] = await Promise.all(files.map(async (name) => {
    const source = await readFile(join(migrationDirectory, name), "utf8");
    const statements = source.split(/-->\s*statement-breakpoint\s*/).map((sql) => sql.trim()).filter(Boolean);
    if (statements.length === 0) throw new Error(`Migration ${name} contains no executable SQL.`);
    return { name, checksum: createHash("sha256").update(source).digest("hex"), statements };
  }));

  const transaction = await client.transaction("write");
  let committed = false;
  try {
    await transaction.execute(`CREATE TABLE IF NOT EXISTS newsjack_schema_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const applied = new Map((await transaction.execute(
      "SELECT name, checksum FROM newsjack_schema_migrations",
    )).rows.map((row) => [String(row.name), String(row.checksum)]));
    let changed = 0;
    for (const migration of migrations) {
      const existingChecksum = applied.get(migration.name);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== migration.checksum) throw new Error(`Applied migration ${migration.name} does not match the packaged checksum.`);
        continue;
      }
      for (const sql of migration.statements) await transaction.execute(sql);
      await transaction.execute({
        sql: "INSERT INTO newsjack_schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
        args: [migration.name, migration.checksum, new Date().toISOString()],
      });
      changed += 1;
    }
    await transaction.commit();
    committed = true;
    return changed;
  } catch (error) {
    if (!committed) await transaction.rollback().catch(() => undefined);
    throw error;
  } finally {
    transaction.close();
  }
}
