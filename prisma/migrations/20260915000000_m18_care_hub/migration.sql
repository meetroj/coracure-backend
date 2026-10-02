-- M-18 Care Hub: `content_items`, ONE table for seven kinds of content.
--
-- One table rather than seven because they differ only in what they are FOR. A
-- self-help tool, an education module, a blog, a caregiver guide, the emergency
-- guidance, an NGO listing and a specialty red-flag reference all have a title,
-- a summary, a body and a review status, and all move through the same
-- authoring and clinical-review workflow.
--
-- The review status is the point: content is authored by an admin and
-- CLINICALLY REVIEWED before a patient sees it, and none of it needs an app
-- release (M-18's completion criterion).

-- CreateEnum
CREATE TYPE "content_item_type" AS ENUM (
  'self_help_tool', 'education_module', 'blog_article', 'caregiver_guide',
  'emergency_guidance', 'support_org', 'clinical_reference'
);

CREATE TYPE "content_review_status" AS ENUM (
  'draft', 'in_clinical_review', 'published', 'archived'
);

-- CreateTable
CREATE TABLE "content_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "item_type" "content_item_type" NOT NULL,
    -- Stable and human-readable: what a deep link names an item by, so a
    -- re-titled article keeps its address.
    "slug" VARCHAR(160) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(400),
    -- Structured blocks. For `support_org` this holds the phone, address and
    -- timings FR-15.6 asks for - a shape that suits one item type only, which
    -- is why it lives here rather than as seven mostly-null columns.
    "body" JSONB NOT NULL,
    "concern_id" UUID,
    "specialty_id" UUID,
    -- A STORAGE KEY, not a `patient_files` row: content media is public and has
    -- no patient owner, so it must not go through the patient-ownership guard.
    "cover_storage_key" TEXT,
    -- `support_org` only. FR-15.6 requires it shown AND filtered on.
    "is_verified_org" BOOLEAN,
    "review_status" "content_review_status" NOT NULL DEFAULT 'draft',
    -- The clinical reviewer is the CLIENT, not the developer (SRS 8).
    "reviewed_by_admin_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_items_slug_key" ON "content_items"("slug");
-- The shelf: everything of one kind that is published.
CREATE INDEX "content_items_item_type_review_status_idx"
  ON "content_items"("item_type", "review_status");
-- FR-15.2's condition-wise shelving.
CREATE INDEX "content_items_concern_id_item_type_idx"
  ON "content_items"("concern_id", "item_type");

-- AddForeignKey
-- SET NULL on both: retiring a concern or a specialty must not delete the
-- articles written about it. An unshelved article is still worth reading, and a
-- doctor may have recommended it last week.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_concern_id_fkey"
  FOREIGN KEY ("concern_id") REFERENCES "concerns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_specialty_id_fkey"
  FOREIGN KEY ("specialty_id") REFERENCES "specialties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- NO ACTION: an admin leaving must not erase who signed a piece of clinical
-- content off. That is the record the review rests on.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_reviewed_by_admin_id_fkey"
  FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admins"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- *** NOTHING IS PUBLISHED WITHOUT A NAMED REVIEWER. ***
--
-- FR-15.3's "clinician-reviewed" has to mean somebody reviewed it, and SRS 8
-- makes that somebody the client's clinician rather than the developer. A
-- published row with no reviewer would be content that reached a patient with
-- nobody's name against it - which is exactly the state this table exists to
-- make impossible.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_published_has_a_reviewer"
  CHECK (
    "review_status" <> 'published'
    OR ("reviewed_by_admin_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  );

-- A reviewer and a review time arrive together or not at all.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_review_is_whole"
  CHECK (("reviewed_by_admin_id" IS NULL) = ("reviewed_at" IS NULL));

-- *** VERIFICATION BELONGS TO AN ORGANISATION AND NOTHING ELSE. ***
-- FR-15.6's verified flag is meaningless on a blog post, and a NULL there is
-- what makes "verified" and "not verified" the only two answers for a listing.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_verification_is_for_orgs"
  CHECK (("item_type" = 'support_org') = ("is_verified_org" IS NOT NULL));

-- The body is structured blocks: an OBJECT, not an array and not a bare string.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_body_is_an_object"
  CHECK (jsonb_typeof("body") = 'object');

-- A slug is what a deep link carries, so it has to survive a URL unescaped.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_slug_is_url_safe"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- *** THE PATIENT-FACING SHELF. ***
-- Every read a patient makes is "published items of this kind, in shelf order".
-- A partial index because published is the minority state in a library that is
-- constantly being drafted and revised, and the only one a patient ever matches.
CREATE INDEX "content_items_published_shelf"
  ON "content_items" ("item_type", "sort_order", "created_at")
  WHERE "review_status" = 'published';

-- FR-15.6's directory: verified organisations first, which is how a helpline
-- list has to be ordered when somebody is in distress.
CREATE INDEX "content_items_verified_orgs"
  ON "content_items" ("is_verified_org", "sort_order")
  WHERE "item_type" = 'support_org' AND "review_status" = 'published';
