CREATE TABLE `audit_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`session_id` text NOT NULL,
	`adapter` text NOT NULL,
	`tier` text NOT NULL,
	`kind` text NOT NULL,
	`prompt` text NOT NULL,
	`response` text NOT NULL,
	`outcome` text NOT NULL,
	`error_code` text,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`cost_usd` real,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_turns_session` ON `audit_turns` (`session_id`);--> statement-breakpoint
CREATE INDEX `audit_turns_started_at` ON `audit_turns` (`started_at`);