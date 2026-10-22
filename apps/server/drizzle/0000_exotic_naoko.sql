CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`payload_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dare_rounds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dare_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`second_player_id` integer,
	`outcome` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`dare_id`) REFERENCES `dares`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`second_player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`intensity` text DEFAULT 'mild' NOT NULL,
	`points` integer DEFAULT 10 NOT NULL,
	`timer_s` integer,
	`uses_second_player` integer DEFAULT false NOT NULL,
	`one_time` integer DEFAULT false NOT NULL,
	`used` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `games` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'lobby' NOT NULL,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`state_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `players` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`phone` text NOT NULL,
	`name` text NOT NULL,
	`avatar` text,
	`pin_hash` text,
	`points` integer DEFAULT 0 NOT NULL,
	`banned` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_phone_unique` ON `players` (`phone`);--> statement-breakpoint
CREATE UNIQUE INDEX `players_name_unique` ON `players` (`name`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`player_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
