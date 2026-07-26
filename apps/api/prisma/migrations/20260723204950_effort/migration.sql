-- CreateEnum
CREATE TYPE "Effort" AS ENUM ('quick', 'medium', 'long');

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "effort" "Effort";
