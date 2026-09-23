CREATE TABLE `sec_filing_queue` (
	`owner_id` text NOT NULL,
	`native_id` text NOT NULL,
	`cik` text NOT NULL,
	`accession` text NOT NULL,
	`issuer_json` text NOT NULL,
	`form` text NOT NULL,
	`primary_document` text NOT NULL,
	`primary_description` text NOT NULL,
	`filed_at` text NOT NULL,
	`available_at` text NOT NULL,
	`available_precision` text NOT NULL CHECK (`available_precision` IN ('second', 'day')),
	`source_version_digest` text NOT NULL,
	`contract_digest` text NOT NULL,
	`public_discovered` integer NOT NULL CHECK (`public_discovered` IN (0, 1)),
	`attempt_count` integer NOT NULL DEFAULT 0 CHECK (`attempt_count` >= 0),
	`next_attempt_at` text NOT NULL,
	`last_error` text,
	`discovered_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `native_id`)
);
--> statement-breakpoint
CREATE INDEX `sec_queue_owner_public_due_idx` ON `sec_filing_queue` (`owner_id`, `public_discovered`, `next_attempt_at`, `filed_at`);
--> statement-breakpoint
CREATE INDEX `sec_queue_owner_cik_due_idx` ON `sec_filing_queue` (`owner_id`, `cik`, `next_attempt_at`, `filed_at`);
--> statement-breakpoint
CREATE TABLE `sec_issuer_retries` (
	`owner_id` text NOT NULL,
	`scope` text NOT NULL CHECK (`scope` IN ('public', 'watchlist')),
	`cik` text NOT NULL,
	`issuer_json` text NOT NULL,
	`attempt_count` integer NOT NULL DEFAULT 0 CHECK (`attempt_count` >= 0),
	`next_attempt_at` text NOT NULL,
	`last_error` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `scope`, `cik`)
);
--> statement-breakpoint
CREATE INDEX `sec_issuer_retry_due_idx` ON `sec_issuer_retries` (`owner_id`, `scope`, `next_attempt_at`, `cik`);
