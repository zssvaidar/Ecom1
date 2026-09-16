import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260916071220 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "twenty_sync_event" drop constraint if exists "twenty_sync_event_idempotency_key_unique";`);
    this.addSql(`create table if not exists "twenty_sync_event" ("id" text not null, "idempotency_key" text not null, "event_name" text not null, "payload" jsonb not null, "status" text check ("status" in ('pending', 'delivered', 'dead')) not null default 'pending', "attempts" integer not null default 0, "last_error" text null, "delivered_at" timestamptz null, "first_attempted_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "twenty_sync_event_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_twenty_sync_event_idempotency_key_unique" ON "twenty_sync_event" ("idempotency_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_twenty_sync_event_deleted_at" ON "twenty_sync_event" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "twenty_sync_event" cascade;`);
  }

}
