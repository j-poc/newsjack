CREATE TABLE `sec_discovery_replays` (
  `owner_id` text NOT NULL,
  `scope` text NOT NULL CHECK (`scope` IN ('public', 'watchlist')),
  `cik` text NOT NULL,
  `native_id` text NOT NULL,
  `capture_sha256` text NOT NULL,
  `issuer_json` text NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`owner_id`, `scope`, `cik`)
);
