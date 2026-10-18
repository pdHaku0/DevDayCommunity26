CREATE TABLE `contacts` (
	`a` text NOT NULL,
	`b` text NOT NULL,
	`active` integer NOT NULL,
	PRIMARY KEY(`a`, `b`)
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription` text NOT NULL,
	`peer` text NOT NULL,
	`occurred` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`inviter` text NOT NULL,
	`expires` integer NOT NULL,
	`acceptor` text,
	`receipt` text,
	`confirmed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`envelope` text,
	`fingerprint` text NOT NULL,
	`created` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_recipient` ON `messages` (`recipient`);--> statement-breakpoint
CREATE INDEX `messages_sender` ON `messages` (`sender`);--> statement-breakpoint
CREATE TABLE `peers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`label` text NOT NULL,
	`box` text NOT NULL,
	`sign` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `peers_owner` ON `peers` (`owner`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`peer` text NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`expires` integer NOT NULL
);
