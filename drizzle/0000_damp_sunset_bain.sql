CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`dedupe_key` text,
	`payload_json` text NOT NULL,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_session_dedupe_key_idx` ON `events` (`session_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`title` text,
	`updated_at` integer NOT NULL
);
