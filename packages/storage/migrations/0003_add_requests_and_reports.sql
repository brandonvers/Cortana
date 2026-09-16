CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`sender` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`lease_owner` text,
	`lease_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer
);
--> statement-breakpoint
CREATE INDEX `reports_request_idx` ON `reports` (`request_id`);--> statement-breakpoint
CREATE INDEX `reports_state_idx` ON `reports` (`state`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`expected` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
