-- The admin's reason for turning an application down, shown to the doctor.
ALTER TABLE "doctors" ADD COLUMN     "rejection_reason" VARCHAR(255);
