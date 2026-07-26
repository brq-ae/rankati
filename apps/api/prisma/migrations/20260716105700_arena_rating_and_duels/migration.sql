-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "duelCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rating" DECIMAL(12,6) NOT NULL DEFAULT 1000;

-- CreateTable
CREATE TABLE "Duel" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "winnerId" TEXT NOT NULL,
    "loserId" TEXT NOT NULL,
    "kWinner" INTEGER NOT NULL,
    "kLoser" INTEGER NOT NULL,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Duel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Duel_seq_key" ON "Duel"("seq");

-- CreateIndex
CREATE INDEX "Duel_ownerId_seq_idx" ON "Duel"("ownerId", "seq");

-- CreateIndex
CREATE INDEX "Duel_sessionId_idx" ON "Duel"("sessionId");

-- CreateIndex
CREATE INDEX "Task_ownerId_status_duelCount_idx" ON "Task"("ownerId", "status", "duelCount");

-- CreateIndex
CREATE INDEX "Task_ownerId_status_rating_idx" ON "Task"("ownerId", "status", "rating");

-- AddForeignKey
ALTER TABLE "Duel" ADD CONSTRAINT "Duel_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Duel" ADD CONSTRAINT "Duel_loserId_fkey" FOREIGN KEY ("loserId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
