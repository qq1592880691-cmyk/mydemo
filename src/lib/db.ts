import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const g = globalThis as unknown as { __miraDb?: Database.Database };

// 初回接続時に schema/seed を流す。どちらも冪等なので毎起動で問題ない
export function getDb(): Database.Database {
  if (g.__miraDb) return g.__miraDb;
  const file = process.env.DB_PATH || path.join(process.cwd(), "data", "mira.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const dir = path.join(process.cwd(), "db");
  db.exec(fs.readFileSync(path.join(dir, "schema.sql"), "utf8"));
  db.exec(fs.readFileSync(path.join(dir, "seed.sql"), "utf8"));
  migrate(db, path.join(dir, "migrations"));
  g.__miraDb = db;
  return db;
}

// migrations/ 配下を番号順に一度だけ適用する
function migrate(db: Database.Database, dir: string) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))");
  if (!fs.existsSync(dir)) return;
  const done = new Set((db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(f);
    })();
  }
}
