import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { LegalDocumentType, PrismaClient } from '@prisma/client';

import { hashPassword } from '../src/identity/password';

/**
 * Environment bootstrap. Idempotent: every step leaves existing rows exactly as
 * they are, so running it on a live environment cannot reset a password or
 * replace legal copy someone has already accepted.
 *
 *   ADMIN_EMAIL=you@coracure.in ADMIN_PASSWORD=<12+ chars> npm run db:seed
 */

/**
 * M-03. Placeholder legal copy so consent, the pre-consult gate and the app's
 * legal screens can be exercised end to end.
 *
 * *** THIS TEXT IS NOT THE CLIENT'S LEGAL COPY. ***
 * SRS section 8 and MODULES section 7 make all legal and clinical wording the
 * client's to author and approve. Each of these is published as version `0.0`
 * so it is obvious in the admin panel that it is a placeholder; publishing the
 * real text as `1.0` supersedes it and keeps this row as history.
 */
const PLACEHOLDER_LEGAL: { documentType: LegalDocumentType; title: string; body: string }[] = [
  {
    documentType: 'teleconsultation_consent',
    title: 'Teleconsultation Consent',
    body: 'PLACEHOLDER - awaiting the client\'s approved wording. Consent to consult a registered practitioner by video, to the recording of clinical notes, and to the limits of remote assessment.',
  },
  {
    documentType: 'privacy_policy',
    title: 'Privacy Policy',
    body: 'PLACEHOLDER - awaiting the client\'s approved wording. What is collected, why, how long it is kept, and how to request deletion.',
  },
  {
    documentType: 'terms_of_use',
    title: 'Terms of Use',
    body: 'PLACEHOLDER - awaiting the client\'s approved wording.',
  },
  {
    documentType: 'refund_policy',
    title: 'Refund Policy',
    body: 'PLACEHOLDER - awaiting the client\'s approved wording. Cancellation windows and how a refund is raised.',
  },
  {
    documentType: 'reconsult_policy',
    title: 'Reconsultation Policy',
    body: 'PLACEHOLDER - awaiting the client\'s approved wording.',
  },
  {
    documentType: 'doctor_agreement',
    title: 'Practitioner Agreement',
    body: 'PLACEHOLDER - awaiting the client\'s approved wording.',
  },
];

async function seedFirstAdmin(prisma: PrismaClient): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.log('Skipping the first admin: set ADMIN_EMAIL and ADMIN_PASSWORD to create one.');
    return;
  }
  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  }

  const existing = await prisma.admin.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    console.log(`  admin ${email} already exists (${existing.id}) - left untouched`);
    return;
  }

  // Every other admin is created by an admin (MODULES M-02: no self sign-up),
  // which leaves nobody to create the first. This is that one bootstrap.
  const admin = await prisma.admin.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      fullName: process.env.ADMIN_NAME?.trim() || 'Platform Administrator',
      permissionLevel: 'super_admin',
      // Turned on from the panel later; the first sign-in must not depend on an
      // OTP provider that may not be configured yet.
      is2faEnabled: false,
    },
    select: { id: true },
  });
  console.log(`  created super_admin ${email} (${admin.id})`);
}

async function seedLegalDocuments(prisma: PrismaClient): Promise<void> {
  for (const document of PLACEHOLDER_LEGAL) {
    const existing = await prisma.legalDocument.findFirst({
      where: { documentType: document.documentType },
      select: { id: true, version: true, isCurrent: true },
    });
    if (existing) {
      console.log(`  ${document.documentType}: version ${existing.version} exists - left untouched`);
      continue;
    }
    await prisma.legalDocument.create({
      data: { ...document, version: '0.0', isCurrent: true },
    });
    console.log(`  ${document.documentType}: published placeholder version 0.0`);
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    console.log('M-02 Identity:');
    await seedFirstAdmin(prisma);
    console.log('M-03 Legal documents (PLACEHOLDER copy - not the client\'s wording):');
    await seedLegalDocuments(prisma);
    console.log('Done.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
