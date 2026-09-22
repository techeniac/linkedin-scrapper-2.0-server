-- CreateTable
CREATE TABLE "next_step_gap_snapshots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "touched_count" INTEGER NOT NULL,
    "never_touched_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "next_step_gap_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "next_step_gap_snapshots_snapshot_date_idx" ON "next_step_gap_snapshots"("snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "next_step_gap_snapshots_user_id_snapshot_date_key" ON "next_step_gap_snapshots"("user_id", "snapshot_date");

-- AddForeignKey
ALTER TABLE "next_step_gap_snapshots" ADD CONSTRAINT "next_step_gap_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
