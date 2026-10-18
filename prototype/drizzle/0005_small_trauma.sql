ALTER TABLE `f_update_preferences` ADD `publisher_registered` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `f_update_preferences` ADD `registration_error` text;--> statement-breakpoint
ALTER TABLE `f_update_preferences` DROP COLUMN `automatic`;