CREATE TABLE `screening_runs_v2` (
	`owner_id` text NOT NULL,
	`source_provider` text NOT NULL,
	`native_id` text NOT NULL,
	`source_digest` text NOT NULL,
	`source_version_digest` text NOT NULL,
	`contract_digest` text NOT NULL,
	`evidence_complete` integer NOT NULL CHECK (`evidence_complete` IN (0, 1)),
	`capture_kind` text NOT NULL CHECK (`capture_kind` IN ('abstract', 'full_text')),
	`status` text NOT NULL,
	`result_digest` text NOT NULL,
	`prompt_digest` text NOT NULL,
	`model` text NOT NULL,
	`screened_at` text NOT NULL,
	`last_validated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `source_provider`, `native_id`, `source_digest`, `source_version_digest`, `contract_digest`)
);
--> statement-breakpoint
INSERT INTO `screening_runs_v2` (
	`owner_id`, `source_provider`, `native_id`, `source_digest`, `source_version_digest`,
	`contract_digest`, `evidence_complete`, `capture_kind`, `status`, `result_digest`,
	`prompt_digest`, `model`, `screened_at`, `last_validated_at`
)
SELECT `owner_id`, `source_provider`, `native_id`, `source_digest`, `source_digest`,
	'', 0, 'abstract', `status`, `result_digest`, `prompt_digest`, `model`, `screened_at`, `screened_at`
FROM `screening_runs`;
--> statement-breakpoint
CREATE INDEX `screening_v2_owner_screened_idx` ON `screening_runs_v2` (`owner_id`, `screened_at`);
