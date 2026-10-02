-- CreateEnum
CREATE TYPE "consultation_channel" AS ENUM ('video', 'audio');

-- CreateEnum
CREATE TYPE "report_request_category" AS ENUM ('prescription', 'lab', 'history', 'other');

-- AlterTable
ALTER TABLE "doctors" ADD COLUMN     "bank_verified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "doctor_availability" ADD COLUMN     "channels" "consultation_channel"[] DEFAULT ARRAY['video', 'audio']::"consultation_channel"[];

-- AlterTable
ALTER TABLE "report_requests" ADD COLUMN     "category" "report_request_category" NOT NULL DEFAULT 'other';

-- AlterTable
ALTER TABLE "consultations" ADD COLUMN     "channel" "consultation_channel" NOT NULL DEFAULT 'video';

-- AlterTable
ALTER TABLE "clarification_cases" ADD COLUMN     "topic" VARCHAR(120);

