CREATE TABLE `agent_events` (
	`agent_id` text,
	`compact_history_json` text,
	`created_at` integer NOT NULL,
	`herdr_session_name` text NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`idempotency_key` text,
	`pane_id` text,
	`payload_json` text NOT NULL,
	`type` text NOT NULL,
	`workspace_id` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`herdr_session_name`) REFERENCES `herdr_sessions`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_events_session_idempotency_idx` ON `agent_events` (`herdr_session_name`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `agent_history_cache` (
	`compact_history_json` text NOT NULL,
	`formatter_version` text NOT NULL,
	`history_ref_json` text NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_mtime_ms` integer NOT NULL,
	`source_path` text NOT NULL,
	`source_size` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_history_cache_source_formatter_idx` ON `agent_history_cache` (`source_path`,`formatter_version`);--> statement-breakpoint
CREATE TABLE `agent_notification_cursors` (
	`acked_event_id` integer DEFAULT 0 NOT NULL,
	`auto_resume_event_id` integer DEFAULT 0 NOT NULL,
	`delivered_event_id` integer DEFAULT 0 NOT NULL,
	`hidden_context_event_id` integer DEFAULT 0 NOT NULL,
	`subscription_id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `agent_notification_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_notification_subscriptions` (
	`auto_resume` integer NOT NULL,
	`created_at` integer NOT NULL,
	`herdr_session_name` text,
	`id` text PRIMARY KEY NOT NULL,
	`subscriber_id` text NOT NULL,
	`subscriber_kind` text NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_notification_subscriptions_scope_subscriber_idx` ON `agent_notification_subscriptions` (`herdr_session_name`,`workspace_id`,`subscriber_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`agent` text,
	`agent_session_json` text,
	`agent_status` text NOT NULL,
	`cwd` text,
	`first_seen_at` integer NOT NULL,
	`focused` integer NOT NULL,
	`foreground_cwd` text,
	`herdr_session_name` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_seen_at` integer NOT NULL,
	`pane_id` text NOT NULL,
	`tab_id` text,
	`terminal_id` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`herdr_session_name`) REFERENCES `herdr_sessions`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_session_pane_idx` ON `agents` (`herdr_session_name`,`pane_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_session_terminal_idx` ON `agents` (`herdr_session_name`,`terminal_id`);--> statement-breakpoint
CREATE TABLE `herdr_sessions` (
	`last_scanned_at` integer,
	`name` text PRIMARY KEY NOT NULL,
	`running` integer NOT NULL,
	`session_dir` text NOT NULL,
	`socket_path` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `herdr_workspaces` (
	`agent_status` text NOT NULL,
	`focused` integer NOT NULL,
	`herdr_session_name` text NOT NULL,
	`label` text,
	`last_seen_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`herdr_session_name`) REFERENCES `herdr_sessions`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `herdr_workspaces_session_workspace_idx` ON `herdr_workspaces` (`herdr_session_name`,`workspace_id`);