-- CreateTable
CREATE TABLE "TelegramConfig" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "botToken" TEXT,
    "boundChatId" TEXT,
    "linkCode" TEXT,
    "digestEnabled" BOOLEAN NOT NULL DEFAULT false,
    "digestTime" TEXT NOT NULL DEFAULT '08:00',
    "timezone" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramConfig_ownerId_key" ON "TelegramConfig"("ownerId");

-- CreateIndex
CREATE INDEX "TelegramConfig_ownerId_idx" ON "TelegramConfig"("ownerId");
