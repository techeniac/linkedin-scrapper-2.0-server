-- CreateTable
CREATE TABLE "scheduled_no_touch_snapshots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_no_touch_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_no_touch_snapshots_snapshot_date_idx" ON "scheduled_no_touch_snapshots"("snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_no_touch_snapshots_user_id_snapshot_date_key" ON "scheduled_no_touch_snapshots"("user_id", "snapshot_date");

-- AddForeignKey
ALTER TABLE "scheduled_no_touch_snapshots" ADD CONSTRAINT "scheduled_no_touch_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
