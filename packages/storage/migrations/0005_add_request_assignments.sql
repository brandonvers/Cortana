CREATE TABLE `request_assignments` (
	`request_id` text NOT NULL,
	`assignee` text NOT NULL,
	PRIMARY KEY(`request_id`, `assignee`)
);
--> statement-breakpoint
ALTER TABLE `requests` ADD `timed_out_at` integer;--> statement-breakpoint
ALTER TABLE `requests` ADD `closed_at` integer;