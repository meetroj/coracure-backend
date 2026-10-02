import { PatientFileCategory } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import { ObjectStorage, SignedUrl } from '../storage/object-storage';

/**
 * Where a patient's clinical files live.
 *
 * The same signing as M-05's credentials - `src/storage/object-storage.ts` -
 * under a DIFFERENT prefix and a different access rule. Separate prefixes are
 * not decoration: a bucket policy, a lifecycle rule or a retention job can then
 * treat somebody's identity document and somebody's blood report differently,
 * and one module's key can never be mistaken for the other's.
 */
export const PATIENT_FILE_STORAGE = Symbol('PatientFileStorage');

export type PatientFileStorage = ObjectStorage;
export type { SignedUrl };

/** The one prefix every patient file lives under. */
const PREFIX = 'patient-files';

/**
 * The client never chooses where its file lands. The key is minted here from
 * the patient's own id and a fresh uuid, so one patient cannot write over
 * another's report by naming their key, and a file name from a form cannot walk
 * out of the prefix.
 */
export function patientFileKey(
  patientId: string,
  category: PatientFileCategory,
  fileName: string,
): string {
  const extension = extname(fileName)
    .toLowerCase()
    .slice(0, 10)
    .replace(/[^.a-z0-9]/g, '');
  return `${PREFIX}/${patientId}/${category}/${randomUUID()}${extension}`;
}

/** True only for a key this service minted for THAT patient. */
export function keyBelongsToPatient(key: string, patientId: string): boolean {
  return key.startsWith(`${PREFIX}/${patientId}/`);
}
