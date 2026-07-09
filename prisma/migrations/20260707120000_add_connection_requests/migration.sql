-- CreateEnum
CREATE TYPE "ConnectionRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'NOT_ACCEPTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "connection_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "target_linkedin_id" TEXT NOT NULL,
    "target_profile_url" TEXT,
    "target_name" TEXT,
    "status" "ConnectionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connection_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connection_requests_user_id_idx" ON "connection_requests"("user_id");

-- CreateIndex
CREATE INDEX "connection_requests_status_idx" ON "connection_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "connection_requests_user_id_target_linkedin_id_key" ON "connection_requests"("user_id", "target_linkedin_id");

-- AddForeignKey
ALTER TABLE "connection_requests" ADD CONSTRAINT "connection_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
