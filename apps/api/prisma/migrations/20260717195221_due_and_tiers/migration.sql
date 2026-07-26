-- CreateEnum
CREATE TYPE "TaskTier" AS ENUM ('normal', 'important', 'super_important', 'critical');

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "due" DATE,
ADD COLUMN     "tier" "TaskTier" NOT NULL DEFAULT 'normal';
