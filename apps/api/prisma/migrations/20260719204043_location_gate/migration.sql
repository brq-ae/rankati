-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL DEFAULT 'local',

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskLocation" (
    "taskId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskLocation_pkey" PRIMARY KEY ("taskId","locationId")
);

-- CreateIndex
CREATE INDEX "Location_ownerId_idx" ON "Location"("ownerId");

-- CreateIndex
CREATE INDEX "TaskLocation_locationId_idx" ON "TaskLocation"("locationId");

-- AddForeignKey
ALTER TABLE "TaskLocation" ADD CONSTRAINT "TaskLocation_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskLocation" ADD CONSTRAINT "TaskLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CASE-INSENSITIVE UNIQUENESS (ADR 0061), hand-added: an expression index Prisma's schema
-- cannot express. This is the DB FLOOR — "garage" cannot create a second "Garage" even under a
-- race the service-side pre-check would lose. Not in schema.prisma, so prisma migrate cannot
-- drift-detect it; a dedicated test asserts this index exists so its loss fails loudly.
CREATE UNIQUE INDEX "Location_ownerId_lower_name_key" ON "Location" ("ownerId", lower("name"));

-- SEED the starting set (ADR 0060), stored with the capitalisation as written and freely
-- renameable/deletable. Owned by the single local owner (0039).
INSERT INTO "Location" ("id", "name", "ownerId") VALUES
  (gen_random_uuid(), 'Home', 'local'),
  (gen_random_uuid(), 'Office/Work', 'local'),
  (gen_random_uuid(), 'Garage', 'local'),
  (gen_random_uuid(), 'Shop/Mall', 'local');
