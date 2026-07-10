CREATE TABLE `agent_orchestrator_scopes` (
	`acked_event_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`herdr_session_name` text NOT NULL,
	`owner_pane_id` text,
	`owner_terminal_id` text,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`herdr_session_name`, `workspace_id`),
	FOREIGN KEY (`herdr_session_name`) REFERENCES `herdr_sessions`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `agent_events` ADD `terminal_id` text;