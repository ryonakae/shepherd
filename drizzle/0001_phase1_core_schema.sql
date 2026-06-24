CREATE TABLE `actors` (
	`id` text PRIMARY KEY NOT NULL,
	`avatar_url` text,
	`created_at` integer NOT NULL,
	`display_name` text NOT NULL,
	`kind` text NOT NULL,
	`presentation_json` text,
	`source_platform` text,
	`source_user_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actors_source_identity_idx` ON `actors` (`source_platform`,`source_user_id`);--> statement-breakpoint
CREATE TABLE `delivery_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`event_id` integer NOT NULL,
	`failure_reason` text,
	`platform` text NOT NULL,
	`remote_message_id` text,
	`status` text NOT NULL,
	`target_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_receipts_event_target_idx` ON `delivery_receipts` (`event_id`,`platform`,`target_id`);--> statement-breakpoint
CREATE TABLE `gateway_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`recovery_json` text,
	`session_id` text NOT NULL,
	`started_at` integer,
	`status` text NOT NULL,
	`triggering_event_id` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`triggering_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `herdr_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`herdr_session_name` text NOT NULL,
	`metadata_json` text,
	`session_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `herdr_bindings_session_idx` ON `herdr_bindings` (`session_id`);--> statement-breakpoint
CREATE TABLE `logical_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`input_json` text NOT NULL,
	`result_json` text,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`tool_name` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `logical_tool_calls_session_idempotency_idx` ON `logical_tool_calls` (`session_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `session_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`message_id` text,
	`metadata_json` text,
	`platform` text NOT NULL,
	`session_id` text NOT NULL,
	`space_id` text,
	`thread_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_bindings_platform_thread_idx` ON `session_bindings` (`platform`,`space_id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `session_summaries` (
	`session_id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `working_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`detection_metadata_json` text,
	`herdr_session_name` text,
	`label` text NOT NULL,
	`path` text NOT NULL,
	`slug` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `working_contexts_slug_idx` ON `working_contexts` (`slug`);--> statement-breakpoint
DROP INDEX `events_session_dedupe_key_idx`;--> statement-breakpoint
ALTER TABLE `events` ADD `actor_id` text REFERENCES actors(id);--> statement-breakpoint
CREATE UNIQUE INDEX `events_session_idempotency_key_idx` ON `events` (`session_id`,`dedupe_key`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `working_context_id` text REFERENCES working_contexts(id);
