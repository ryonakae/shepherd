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
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` text,
	`created_at` integer NOT NULL,
	`dedupe_key` text,
	`payload_json` text NOT NULL,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_session_idempotency_key_idx` ON `events` (`session_id`,`dedupe_key`);--> statement-breakpoint
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
	`pi_turn_id` text NOT NULL,
	`result_json` text,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`tool_name` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`pi_turn_id`) REFERENCES `pi_turns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `logical_tool_calls_pi_turn_idempotency_idx` ON `logical_tool_calls` (`pi_turn_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `pi_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`input_event_ids_json` text,
	`owner_id` text,
	`owner_kind` text,
	`pi_session_file` text,
	`pi_session_id` text,
	`recovery_json` text,
	`session_id` text NOT NULL,
	`source` text,
	`started_at` integer,
	`status` text NOT NULL,
	`triggering_event_id` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`triggering_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
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
	`summarized_through_event_id` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`metadata_json` text,
	`status` text DEFAULT 'active' NOT NULL,
	`title` text,
	`updated_at` integer NOT NULL,
	`working_context_id` text,
	FOREIGN KEY (`working_context_id`) REFERENCES `working_contexts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `worker_agent_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_name` text NOT NULL,
	`agent_profile` text NOT NULL,
	`agent_status` text NOT NULL,
	`binding_health` text NOT NULL,
	`created_at` integer NOT NULL,
	`description` text,
	`herdr_session_name` text NOT NULL,
	`last_seen_at` integer,
	`last_task` text,
	`metadata_json` text,
	`pane_id` text NOT NULL,
	`role` text NOT NULL,
	`session_id` text NOT NULL,
	`tab_id` text,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_agent_bindings_identity_idx` ON `worker_agent_bindings` (`session_id`,`workspace_id`,`agent_name`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `working_contexts_path_idx` ON `working_contexts` (`path`);