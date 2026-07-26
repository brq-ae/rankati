-- CreateEnum
CREATE TYPE "AvailabilityWindow" AS ENUM ('working_hours', 'workdays', 'weekend');

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "availabilityWindow" "AvailabilityWindow";
