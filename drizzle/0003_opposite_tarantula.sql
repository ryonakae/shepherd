CREATE TABLE `agent_context_snapshots` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`compact_history_json` text NOT NULL,
	`history_ref_json` text,
	`pane_revision` integer,
	`source_path` text,
	`source_mtime_ms` integer,
	`source_size` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `agent_session_hint_json` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `pane_revision` integer;