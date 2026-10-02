import { DoctorDocumentType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import { ObjectStorage, SignedUrl } from '../storage/object-storage';

/**
 * Where a doctor's credential files live.
 *
 * *** BYTES NEVER PASS THROUGH THIS SERVICE. *** The client is handed a
 * short-lived signed URL and talks to the object store directly, so a
 * credential upload cannot occupy an API worker and a stored file has no
 * public address at all: `doctor_documents.storage_key` is never returned to
 * anyone, and a read is a fresh signature that expires in minutes.
 *
 * A port, because M-10 needs the same thing for patient files under a different
 * access rule. The SIGNING is shared - `src/storage/object-storage.ts` - and
 * what stays here is what is specific to a credential: the token, and the key
 * policy that keeps one doctor out of another's prefix.
 */
export const CREDENTIAL_STORAGE = Symbol('CredentialStorage');

/** M-05's name for the shared port. The access rule differs, the signing does not. */
export type CredentialStorage = ObjectStorage;
export type { SignedUrl };

/** The one prefix every doctor credential lives under. */
const PREFIX = 'doctor-documents';

/**
 * The client never chooses where its file lands. The key is minted here from
 * the doctor's own id and a fresh uuid, so one doctor cannot write over
 * another's registration certificate by naming their key, and a file name from
 * a form cannot walk out of the prefix.
 */
export function credentialKey(
  doctorId: string,
  documentType: DoctorDocumentType,
  fileName: string,
): string {
  const extension = extname(fileName)
    .toLowerCase()
    .slice(0, 10)
    .replace(/[^.a-z0-9]/g, '');
  return `${PREFIX}/${doctorId}/${documentType}/${randomUUID()}${extension}`;
}

/** True only for a key this service minted for THAT doctor. */
export function keyBelongsToDoctor(key: string, doctorId: string): boolean {
  return key.startsWith(`${PREFIX}/${doctorId}/`);
}

/**
 * Re-exported so M-05's callers keep one import. The code on the wire is the
 * same string `DoctorsError.STORAGE_UNAVAILABLE` always returned, so nothing a
 * client branches on has changed.
 */
export { storageUnavailable } from '../storage/object-storage';
