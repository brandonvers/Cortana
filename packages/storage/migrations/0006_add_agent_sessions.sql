CREATE TABLE `agent_sessions` (
	`agent` text PRIMARY KEY NOT NULL,
	`runner` text NOT NULL,
	`resume` text NOT NULL,
	`updated_at` integer NOT NULL
);
