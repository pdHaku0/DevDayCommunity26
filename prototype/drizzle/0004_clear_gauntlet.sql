CREATE TABLE `f_update_preferences` (
	`peer` text PRIMARY KEY NOT NULL,
	`notified_version` integer NOT NULL,
	`automatic` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `f_update_subscribers` (
	`origin` text PRIMARY KEY NOT NULL,
	`last_version` integer NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`retry_after` integer DEFAULT 0 NOT NULL
);
