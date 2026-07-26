-- CreateEnum
CREATE TYPE "Impact" AS ENUM ('none', 'medium', 'high');

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "impact" "Impact" NOT NULL DEFAULT 'none';
