DROP INDEX "jobs_idempotency_key_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_uq" ON "jobs" USING btree ("idempotency_key") WHERE status in ('queued', 'running');