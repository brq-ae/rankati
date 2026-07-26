-- CreateEnum
CREATE TYPE "RoutineType" AS ENUM ('frequency', 'interval_floating', 'interval_fixed');

-- CreateEnum
CREATE TYPE "RoutineUnit" AS ENUM ('day', 'week', 'month', 'year');

-- CreateEnum
CREATE TYPE "RoutineFixedRuleKind" AS ENUM ('nth_weekday_of_month', 'day_of_month', 'last_weekday_of_month');

-- CreateTable
CREATE TABLE "Routine" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL DEFAULT 'local',
    "type" "RoutineType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snoozedUntil" TIMESTAMP(3),
    "periodUnit" "RoutineUnit",
    "targetCount" INTEGER,
    "periodCount" INTEGER,
    "periodStart" DATE,
    "intervalUnit" "RoutineUnit",
    "intervalCount" INTEGER,
    "preferredWeekday" INTEGER,
    "nextDue" DATE,
    "ruleKind" "RoutineFixedRuleKind",
    "ruleOrdinal" INTEGER,
    "ruleWeekday" INTEGER,
    "ruleDayOfMonth" INTEGER,
    "acknowledgedDate" DATE,

    CONSTRAINT "Routine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Routine_ownerId_idx" ON "Routine"("ownerId");
