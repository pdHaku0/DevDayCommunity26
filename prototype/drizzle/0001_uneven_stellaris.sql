CREATE TABLE `connection_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`peer` text NOT NULL,
	`ciphertext` text,
	`created` integer NOT NULL,
	`expires` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`other` text
);
--> statement-breakpoint
CREATE INDEX `connection_requests_peer` ON `connection_requests` (`peer`);