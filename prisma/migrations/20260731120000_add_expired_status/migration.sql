-- AlterEnum
--
-- Deliberately isolated in its own migration. PostgreSQL forbids USING a newly
-- added enum value in the same transaction that adds it, so keeping this apart
-- from the table/column changes that reference EXPIRED removes any ordering
-- risk regardless of server version.
ALTER TYPE "ConnectionRequestStatus" ADD VALUE 'EXPIRED';
