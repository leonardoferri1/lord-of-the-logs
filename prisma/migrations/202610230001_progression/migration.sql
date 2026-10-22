-- World v2: progression, combat economy, tools, quests and producing buildings.
ALTER TABLE "Player" ADD COLUMN "iron" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "food" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "gold" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "level" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "xp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "hp" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN "energy" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN "sword" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "axe" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "pickaxe" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "stats" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "claimed" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Building" ADD COLUMN "producedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "plantedAt" TIMESTAMP(3);

ALTER TABLE "Player" DROP CONSTRAINT "inventory_nonnegative";
ALTER TABLE "Player" ADD CONSTRAINT "inventory_nonnegative" CHECK (wood >= 0 AND stone >= 0 AND iron >= 0 AND food >= 0 AND gold >= 0);
ALTER TABLE "Player" ADD CONSTRAINT "progression_bounded" CHECK (level >= 1 AND xp >= 0 AND hp >= 0 AND energy >= 0 AND sword BETWEEN 1 AND 4 AND axe BETWEEN 1 AND 4 AND pickaxe BETWEEN 1 AND 4);
ALTER TABLE "Building" DROP CONSTRAINT "building_kind";
ALTER TABLE "Building" ADD CONSTRAINT "building_kind" CHECK (kind IN ('house', 'farm', 'lumber', 'storage', 'tower'));
