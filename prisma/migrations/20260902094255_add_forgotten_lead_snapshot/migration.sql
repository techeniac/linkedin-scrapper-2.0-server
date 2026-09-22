-- CreateTable
CREATE TABLE "forgotten_lead_snapshots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forgotten_lead_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forgotten_lead_snapshots_snapshot_date_idx" ON "forgotten_lead_snapshots"("snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "forgotten_lead_snapshots_user_id_snapshot_date_key" ON "forgotten_lead_snapshots"("user_id", "snapshot_date");

-- AddForeignKey
ALTER TABLE "forgotten_lead_snapshots" ADD CONSTRAINT "forgotten_lead_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

