-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "pinSnoozedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "pinHighFuseDays" INTEGER NOT NULL DEFAULT 7,
    "pinMediumFuseDays" INTEGER NOT NULL DEFAULT 30,
    "pinHighSnoozeDays" INTEGER NOT NULL DEFAULT 1,
    "pinMediumSnoozeDays" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Settings_ownerId_key" ON "Settings"("ownerId");

-- CreateIndex
CREATE INDEX "Settings_ownerId_idx" ON "Settings"("ownerId");
