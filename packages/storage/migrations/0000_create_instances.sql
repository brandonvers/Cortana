CREATE TABLE `instances` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`started_at` integer NOT NULL,
	`stopped_at` integer
);
