CREATE TABLE `events` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`provider` text NOT NULL,
	`native_id` text NOT NULL,
	`event_json` text NOT NULL,
	`observed_at` text NOT NULL,
	`review_status` text DEFAULT 'unreviewed' NOT NULL,
	`review_note` text DEFAULT '' NOT NULL,
	`review_updated_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_owner_provider_native_uq` ON `events` (`owner_id`,`provider`,`native_id`);--> statement-breakpoint
CREATE INDEX `events_owner_available_idx` ON `events` (`owner_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `meta` (
	`owner_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `refresh_locks` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `screening_runs` (
	`owner_id` text NOT NULL,
	`source_provider` text NOT NULL,
	`native_id` text NOT NULL,
	`source_digest` text NOT NULL,
	`status` text NOT NULL,
	`result_digest` text NOT NULL,
	`prompt_digest` text NOT NULL,
	`model` text NOT NULL,
	`screened_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `source_provider`, `native_id`, `source_digest`)
);
--> statement-breakpoint
CREATE INDEX `screening_owner_screened_idx` ON `screening_runs` (`owner_id`,`screened_at`);--> statement-breakpoint
CREATE TABLE `source_captures` (
	`owner_id` text NOT NULL,
	`provider` text NOT NULL,
	`native_id` text NOT NULL,
	`sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`source_url` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_length` integer NOT NULL,
	`observed_at` text NOT NULL,
	`adapter_version` text NOT NULL,
	PRIMARY KEY(`owner_id`, `provider`, `native_id`, `sha256`)
);
--> statement-breakpoint
CREATE INDEX `captures_owner_observed_idx` ON `source_captures` (`owner_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `source_health` (
	`owner_id` text NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`freshness` text NOT NULL,
	`message` text NOT NULL,
	`checked_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `provider`)
);
--> statement-breakpoint
CREATE TABLE `watchlist` (
	`owner_id` text NOT NULL,
	`cik` text NOT NULL,
	`issuer_json` text NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `cik`)
);
--> statement-breakpoint
CREATE INDEX `watchlist_owner_added_idx` ON `watchlist` (`owner_id`,`added_at`);
