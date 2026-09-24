CREATE TABLE source_capture_objects (
  object_key TEXT PRIMARY KEY NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  original_bytes INTEGER NOT NULL CHECK (original_bytes >= 0 AND original_bytes <= 12582912),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 200),
  custom_metadata_json TEXT NOT NULL,
  encoding TEXT NOT NULL CHECK (encoding = 'gzip'),
  stored_bytes INTEGER NOT NULL CHECK (stored_bytes BETWEEN 0 AND 3145728),
  body BLOB NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(body) = stored_bytes)
);
