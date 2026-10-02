import { Injectable } from '@nestjs/common';
import { ConsultationStatus, DoctorVerificationStatus } from '@prisma/client';

import { AllocationPolicyService, TieBreak } from '../catalogue/allocation-policy.service';
import { AuditService } from '../audit/audit.service';
import { DoctorRegistryService } from '../doctors/doctor-registry.service';
import { PrismaService } from '../database/prisma.service';
import { SchedulingService } from '../scheduling/scheduling.service';

/** What assignment is asked to solve. */
export interface AssignmentRequest {
  specialtyId: string;
  /** FR-20.4. A hard requirement: never relaxed, by anything. */
  language: string;
  /** FR-20.5. A preference the policy may relax. Null if the patient has none. */
  regionId: string | null;
  /** The moment the consultation would start. */
  at: Date;
  /** Providers this patient has already declined on this booking (FR-4.4). */
  excludeDoctorIds?: string[];
}

/**
 * *** WHY THIS PROVIDER. *** Written to the audit log, never to a column.
 *
 * MODULES M-11 is explicit: "the consultation records WHO, the log records WHY,
 * and why is a record of a decision rather than an attribute of the
 * appointment". A `matched_on` jsonb column would be a second copy of a
 * decision that has already happened, and it would go stale the moment the
 * policy or the pool changed underneath it.
 */
export interface MatchedOn {
  specialtyId: string;
  language: string;
  regionId: string | null;
  /** FR-20.5: true when nobody in the region was free and the policy allowed it. */
  regionRelaxed: boolean;
  tieBreak: TieBreak;
  /** How many providers spoke the language and served the region at all. */
  poolSize: number;
  /** How many of those were actually free for long enough (FR-10.7). */
  availableCount: number;
  /** Minutes the chosen provider had free, unbroken, from `at`. */
  availableMinutes: number;
  declinedCount: number;
}

export type AssignmentResult =
  | { assigned: true; doctorId: string; durationMinutes: number; matchedOn: MatchedOn }
  | {
      assigned: false;
      /** FR-20.7: the next time the pool CAN cover it, or null inside the horizon. */
      soonestAvailableAt: Date | null;
      /** Why nothing matched, for the panel and the audit entry. */
      reason: 'no_provider_speaks_the_language' | 'none_free_for_long_enough' | 'all_declined';
    };

/**
 * *** SRS 4.20: THE SYSTEM ASSIGNS THE PROVIDER. ***
 *
 * The patient picks a service and a time and never a person (FR-20.1), so this
 * is the code that decides who they see. It takes the four inputs FR-20.2 names
 * and nothing else:
 *
 *   1. the **specialty** the service requires;
 *   2. the patient's **preferred language** - a HARD rule (FR-20.4). There is
 *      no policy setting that relaxes it, and there is no branch below that
 *      can skip it, because a provider who cannot speak to the patient is not
 *      a provider for that patient;
 *   3. the patient's **region** - a preference the admin's policy may relax
 *      (FR-20.5), recording that it did, so a thin regional pool never leaves
 *      somebody unable to book;
 *   4. **availability for the requested time**, including the duration still
 *      free at that moment (FR-10.7), asked of M-07 so this module never reads
 *      a diary itself.
 *
 * Where more than one qualifies the tie is broken by the admin's policy
 * (FR-20.6), and where none does the answer is a refusal with the next time the
 * pool can cover it (FR-20.7) - never a fallback to somebody who does not
 * match.
 */
@Injectable()
export class AssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly doctors: DoctorRegistryService,
    private readonly scheduling: SchedulingService,
    private readonly policy: AllocationPolicyService,
    private readonly audit: AuditService,
  ) {}

  async resolve(request: AssignmentRequest): Promise<AssignmentResult> {
    const policy = await this.policy.current();
    const declined = new Set(request.excludeDoctorIds ?? []);

    // 1 and 2. Specialty and language, together, and language is never dropped
    // from this filter on any later branch.
    const inRegion = request.regionId ? await this.pool(request, request.regionId) : [];
    const anywhere = await this.pool(request, undefined);

    if (anywhere.length === 0) {
      return {
        assigned: false,
        soonestAvailableAt: null,
        reason: 'no_provider_speaks_the_language',
      };
    }

    // 3. Region preference. The relaxation is a fallback, not a widening: the
    // in-region pool is tried on its own first, and only an EMPTY result moves
    // outside it.
    let candidates = request.regionId ? inRegion : anywhere;
    let regionRelaxed = false;
    let chosen = await this.firstFree(candidates, request.at, declined);

    if (!chosen && request.regionId && policy.regionRelaxable) {
      candidates = anywhere;
      regionRelaxed = true;
      chosen = await this.firstFree(candidates, request.at, declined);
    }

    if (!chosen) {
      const anyoneAtAll = await this.scheduling.remainingFor(
        candidates.map((doctor) => doctor.id),
        request.at,
      );
      const free = anyoneAtAll.filter((entry) => entry.assignable);
      return {
        assigned: false,
        // Asked of the whole specialty pool rather than the region - the policy
        // may relax region by then anyway - but ALWAYS carrying the language.
        // A time only an English-speaking provider is free at is not a time
        // that covers a patient who needs Hindi, and offering it would send
        // them back to a refusal they had already had.
        soonestAvailableAt: await this.scheduling.soonestForPool(
          { specialtyId: request.specialtyId, language: request.language },
          request.at,
        ),
        // Told apart because the fix differs: one needs more providers, the
        // other needs the patient to accept somebody they turned down.
        reason: free.length > 0 ? 'all_declined' : 'none_free_for_long_enough',
      };
    }

    return {
      assigned: true,
      doctorId: chosen.doctorId,
      durationMinutes: chosen.durationMinutes,
      matchedOn: {
        specialtyId: request.specialtyId,
        language: request.language,
        regionId: request.regionId,
        regionRelaxed,
        tieBreak: policy.tieBreak,
        poolSize: candidates.length,
        availableCount: chosen.availableCount,
        availableMinutes: chosen.availableMinutes,
        declinedCount: declined.size,
      },
    };
  }

  /**
   * Records what the assignment matched on (FR-20.9), so "why did I see this
   * provider" can be answered months later, and so an allocation can be audited
   * under SRS section 8.
   *
   * A refusal is recorded too (FR-20.7). An empty pool is the thing the client
   * most needs to see - it is a staffing signal, and one that leaves no trace
   * anywhere else because no consultation was created.
   */
  async recordDecision(
    consultationId: string | null,
    patientId: string,
    outcome: AssignmentResult,
  ): Promise<void> {
    await this.audit.record({
      actorType: 'system',
      action: outcome.assigned ? 'update' : 'read',
      entityType: 'consultation_assignment',
      entityId: consultationId ?? patientId,
      consultationId,
      metadata: outcome.assigned
        ? { assignedDoctorId: outcome.doctorId, ...outcome.matchedOn }
        : {
            refused: true,
            reason: outcome.reason,
            soonestAvailableAt: outcome.soonestAvailableAt?.toISOString() ?? null,
          },
    });
  }

  // -- Internals ------------------------------------------------------------

  /**
   * Verified, listed, speaking the language, of that specialty - and in the
   * region when one is given.
   *
   * `verificationStatus` and `isListed` are both here because FR-20.3 makes
   * them two separate admin actions and requires both.
   */
  private async pool(request: AssignmentRequest, regionId: string | undefined) {
    return this.doctors.listForAdmin({
      specialtyId: request.specialtyId,
      language: request.language,
      ...(regionId ? { regionId } : {}),
      verificationStatus: DoctorVerificationStatus.verified,
      isListed: true,
      limit: POOL_LIMIT,
    });
  }

  /**
   * Of the candidates, the one the policy picks - among those actually free for
   * their own full duration plus buffer at that moment.
   */
  private async firstFree(
    candidates: { id: string }[],
    at: Date,
    declined: Set<string>,
  ): Promise<{
    doctorId: string;
    durationMinutes: number;
    availableMinutes: number;
    availableCount: number;
  } | null> {
    const eligible = candidates.filter((doctor) => !declined.has(doctor.id));
    if (eligible.length === 0) return null;

    const ids = eligible.map((doctor) => doctor.id);
    const [remaining, profiles] = await Promise.all([
      this.scheduling.remainingFor(ids, at),
      this.doctors.bookingProfilesOf(ids),
    ]);

    // FR-10.7 in one line: free AT the time is not enough, they must be free
    // FOR long enough, and "long enough" is each provider's own slot length.
    const free = remaining.filter((entry) => entry.assignable);
    if (free.length === 0) return null;

    const winner = await this.breakTie(
      free.map((entry) => entry.doctorId),
      free,
    );
    const entry = free.find((candidate) => candidate.doctorId === winner)!;
    return {
      doctorId: winner,
      durationMinutes: profiles.get(winner)?.consultationDurationMinutes ?? DEFAULT_DURATION,
      availableMinutes: entry.availableMinutes,
      availableCount: free.length,
    };
  }

  /**
   * FR-20.6: the tie is broken by a policy the admin sets, and the policy is
   * configuration rather than code.
   *
   * The default spreads work across the pool rather than landing it on whoever
   * sorts first, which is the difference between a roster and a rota.
   */
  private async breakTie(
    doctorIds: string[],
    free: { doctorId: string; availableMinutes: number }[],
  ): Promise<string> {
    const { tieBreak } = await this.policy.current();
    if (doctorIds.length === 1) return doctorIds[0];

    if (tieBreak === 'longest_free') {
      return [...free].sort(
        (a, b) => b.availableMinutes - a.availableMinutes || a.doctorId.localeCompare(b.doctorId),
      )[0].doctorId;
    }

    if (tieBreak === 'least_recently_assigned') {
      const last = await this.prisma.consultation.groupBy({
        by: ['doctorId'],
        where: { doctorId: { in: doctorIds } },
        _max: { createdAt: true },
      });
      const when = new Map(last.map((row) => [row.doctorId!, row._max.createdAt?.getTime() ?? 0]));
      // Never assigned sorts first: a new provider on the roster should get
      // work rather than wait for everyone else to fall behind them.
      return [...doctorIds].sort(
        (a, b) => (when.get(a) ?? 0) - (when.get(b) ?? 0) || a.localeCompare(b),
      )[0];
    }

    // `fewest_upcoming`, the load-balancing default (SRS 20.6).
    const upcoming = await this.prisma.consultation.groupBy({
      by: ['doctorId'],
      where: { doctorId: { in: doctorIds }, status: { in: HOLDS_TIME } },
      _count: { _all: true },
    });
    const load = new Map(upcoming.map((row) => [row.doctorId!, row._count._all]));
    return [...doctorIds].sort(
      (a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b),
    )[0];
  }
}

/** The statuses that actually occupy a provider's time. */
export const HOLDS_TIME: ConsultationStatus[] = [
  ConsultationStatus.pending_payment,
  ConsultationStatus.scheduled,
  ConsultationStatus.awaiting_doctor,
  ConsultationStatus.in_progress,
];

/** A pool larger than this is a catalogue problem, not an assignment one. */
const POOL_LIMIT = 200;
/** Only reachable if a provider row vanished between two queries. */
const DEFAULT_DURATION = 30;
