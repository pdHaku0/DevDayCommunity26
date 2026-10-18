CREATE TABLE `f_connections` (
	`local` text NOT NULL,
	`remote` text NOT NULL,
	`connection_id` text NOT NULL,
	`identity` text NOT NULL,
	`status` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`local`, `remote`, `connection_id`)
);
--> statement-breakpoint
CREATE TABLE `f_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription` text NOT NULL,
	`peer` text NOT NULL,
	`occurred` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `f_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`inviter` text NOT NULL,
	`expires` integer NOT NULL,
	`acceptor` text,
	`receipt` text,
	`acceptance` text,
	`confirmed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `f_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`connection_id` text NOT NULL,
	`envelope` text,
	`fingerprint` text NOT NULL,
	`created` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `f_messages_recipient` ON `f_messages` (`recipient`);--> statement-breakpoint
CREATE INDEX `f_messages_sender` ON `f_messages` (`sender`);--> statement-breakpoint
CREATE TABLE `f_packets` (
	`id` text NOT NULL,
	`direction` text NOT NULL,
	`sender` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created` integer NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`id`, `direction`)
);
--> statement-breakpoint
CREATE INDEX `f_packets_sender` ON `f_packets` (`sender`,`created`);--> statement-breakpoint
CREATE TABLE `f_peers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`label` text NOT NULL,
	`box` text NOT NULL,
	`sign` text NOT NULL,
	`relay` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `f_peers_owner` ON `f_peers` (`owner`);--> statement-breakpoint
CREATE TABLE `f_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`peer` text NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`expires` integer NOT NULL
);
