CREATE TABLE `notification_cursors` (
	`acked_event_id` integer DEFAULT 0 NOT NULL,
	`auto_resume_event_id` integer DEFAULT 0 NOT NULL,
	`delivered_event_id` integer DEFAULT 0 NOT NULL,
	`hidden_context_event_id` integer DEFAULT 0 NOT NULL,
	`subscription_id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `notification_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notification_subscriptions` (
	`auto_resume` integer NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`observed_workspace_id` text NOT NULL,
	`subscriber_id` text NOT NULL,
	`subscriber_kind` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`observed_workspace_id`) REFERENCES `observed_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_subscriptions_workspace_subscriber_idx` ON `notification_subscriptions` (`observed_workspace_id`,`subscriber_id`);--> statement-breakpoint
CREATE TABLE `observed_workspaces` (
	`created_at` integer NOT NULL,
	`herdr_session_name` text,
	`id` text PRIMARY KEY NOT NULL,
	`last_resolved_at` integer,
	`live_workspace_id` text,
	`metadata_json` text NOT NULL,
	`socket_path` text,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_events` (
	`created_at` integer NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`idempotency_key` text,
	`observed_workspace_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`type` text NOT NULL,
	`worker_id` text,
	FOREIGN KEY (`observed_workspace_id`) REFERENCES `observed_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_events_observed_workspace_idempotency_idx` ON `worker_events` (`observed_workspace_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `worker_snapshots` (
	`created_at` integer NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`observed_workspace_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`worker_id` text NOT NULL,
	FOREIGN KEY (`observed_workspace_id`) REFERENCES `observed_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`agent_name` text,
	`agent_session_json` text,
	`current_pane_id` text,
	`current_tab_id` text,
	`current_workspace_id` text,
	`first_seen_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`identity_kind` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	`metadata_json` text NOT NULL,
	`observed_workspace_id` text NOT NULL,
	`runtime` text,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	`worker_key` text NOT NULL,
	FOREIGN KEY (`observed_workspace_id`) REFERENCES `observed_workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workers_observed_workspace_key_idx` ON `workers` (`observed_workspace_id`,`worker_key`);