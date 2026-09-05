CREATE TABLE `agents` (
	`name` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`definition` text,
	`state` text DEFAULT 'dormant' NOT NULL,
	`state_changed_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agents_state_idx` ON `agents` (`state`);