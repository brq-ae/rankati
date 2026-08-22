-- AlterTable
ALTER TABLE "Routine" ADD COLUMN     "lastNaggedAt" TIMESTAMP(3),
ADD COLUMN     "linkedLogId" TEXT,
ADD COLUMN     "nagIntervalMinutes" INTEGER,
ADD COLUMN     "nagSkipUntil" TIMESTAMP(3),
ADD COLUMN     "telegramNag" BOOLEAN NOT NULL DEFAULT false;
