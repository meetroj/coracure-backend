import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ContentItem, ContentItemType, ContentReviewStatus, Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor, assertPermission } from '../common/auth';
import { AppException } from '../common/errors';
import { ContentLibrary, ContentSummary } from '../clinical/content-library';
import { PrismaService } from '../database/prisma.service';
import { ContentError } from './content.errors';

/** What a patient or a doctor is shown on a shelf. Never the review trail. */
export interface PublicContentItem {
  id: string;
  itemType: ContentItemType;
  slug: string;
  title: string;
  summary: string | null;
  concernId: string | null;
  specialtyId: string | null;
  coverStorageKey: string | null;
  /** `support_org` only. FR-15.6 requires it shown. */
  isVerifiedOrg: boolean | null;
  sortOrder: number;
}

/** The full item, body included. What a reader opens. */
export interface PublicContentDetail extends PublicContentItem {
  body: unknown;
}

/** The admin's view: everything above, plus who signed it off. */
export interface AdminContentItem extends PublicContentDetail {
  reviewStatus: ContentReviewStatus;
  reviewedByAdminId: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContentInput {
  itemType: ContentItemType;
  slug: string;
  title: string;
  summary?: string | null;
  body: Record<string, unknown>;
  concernId?: string | null;
  specialtyId?: string | null;
  coverStorageKey?: string | null;
  isVerifiedOrg?: boolean | null;
  sortOrder?: number;
}

export interface ShelfQuery {
  itemType?: ContentItemType;
  concernId?: string;
  specialtyId?: string;
  /** FR-15.6: a directory a patient in distress reads must be filterable. */
  verifiedOnly?: boolean;
  limit?: number;
}

/**
 * M-18 Care Hub. Owns `content_items`, and binds the `CONTENT_LIBRARY` port
 * that M-15 and M-16 have been waiting on.
 *
 * *** PUBLISHED IS THE ONLY THING A PATIENT EVER SEES. ***
 *
 * Every patient-facing read in this file filters on
 * `review_status = 'published'`, and a CHECK refuses a published row with no
 * named reviewer. FR-15.3's "clinician-reviewed" therefore means somebody
 * reviewed it, rather than being a claim in a paragraph - and SRS 8 makes that
 * somebody the client's clinician rather than the developer.
 *
 * *** THERE IS NO CLINICAL DATA HERE, AND THAT IS WHAT MAKES IT SIMPLE. ***
 * The library knows nothing about any patient. A recommendation is a list of
 * ids on the CLINICAL RECORD (M-15); this module only says whether an id is
 * real and what it is called. That is why a shelf can be read without a
 * consultation, and why nothing here needs an ownership check.
 *
 * FR-15.8: no comments, no likes, no forum. There is no peer-content table
 * because there is no peer content.
 */
@Injectable()
export class ContentService implements ContentLibrary {
  private readonly logger = new Logger(ContentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -- The port M-15 and M-16 declared --------------------------------------

  /**
   * FR-15.4's guard. Which of these ids a doctor may NOT recommend.
   *
   * Published only: a draft is unfinished, one in clinical review has not been
   * approved, and an archived item was deliberately retired. Recommending any
   * of the three would put a patient in front of content nobody signed off.
   *
   * Returns the offenders rather than a boolean so the doctor is told which
   * pick is the problem instead of having the whole save refused.
   */
  async unrecommendable(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];

    const found = await this.prisma.contentItem.findMany({
      where: { id: { in: unique }, reviewStatus: ContentReviewStatus.published },
      select: { id: true },
    });
    const publishedIds = new Set(found.map((row) => row.id));
    return unique.filter((id) => !publishedIds.has(id));
  }

  /**
   * The items behind a recommendation, in the order they were recommended.
   *
   * Archived items ARE resolved here, unlike in `unrecommendable`. A doctor's
   * recommendation from last week should not vanish from a Care Plan because
   * the library was tidied since - the patient was told to read it, and the
   * honest thing is to keep showing it.
   *
   * Ids that resolve to nothing are simply absent. A Care Plan showing four of
   * five recommendations is far better than one that fails to load.
   */
  async summaries(ids: string[]): Promise<ContentSummary[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.contentItem.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, slug: true, itemType: true, title: true, summary: true },
    });

    // Back into the order the doctor picked them in. `findMany` returns rows in
    // whatever order the index gives, and a recommendation list is ordered by
    // the clinician's intent rather than by the database's convenience.
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map((row) => ({ ...row, itemType: row.itemType }));
  }

  // -- Reading, for patients and doctors ------------------------------------

  /**
   * A shelf. Published items only, in the order an admin set.
   *
   * No actor parameter and no ownership check, deliberately: this library holds
   * no patient data, so there is nobody it could belong to. The route is still
   * authenticated, because an unauthenticated app has nothing to show it in.
   */
  async shelf(query: ShelfQuery = {}): Promise<PublicContentItem[]> {
    const rows = await this.prisma.contentItem.findMany({
      where: {
        reviewStatus: ContentReviewStatus.published,
        ...(query.itemType ? { itemType: query.itemType } : {}),
        ...(query.concernId ? { concernId: query.concernId } : {}),
        ...(query.specialtyId ? { specialtyId: query.specialtyId } : {}),
        // FR-15.6. Only meaningful on an organisation, and the CHECK makes the
        // column null everywhere else - so this narrows to orgs by itself.
        ...(query.verifiedOnly ? { isVerifiedOrg: true } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(query.limit ?? 100, 200),
    });
    return rows.map(publicItem);
  }

  /** One item, by its slug. Published only. */
  async bySlug(slug: string): Promise<PublicContentDetail> {
    const found = await this.prisma.contentItem.findFirst({
      where: { slug, reviewStatus: ContentReviewStatus.published },
    });
    if (!found) throw notFound();
    return publicDetail(found);
  }

  /**
   * FR-15.7 and SRS 6.3: persistent emergency guidance, reachable from the
   * Care Hub and the home screen.
   *
   * Returns a LIST rather than one item, and never throws when it is empty. A
   * screen that must always render cannot depend on a row existing - the app
   * shows its built-in fallback if this is empty, and the alternative is an
   * error on the one screen somebody in crisis is looking at.
   */
  async emergencyGuidance(): Promise<PublicContentDetail[]> {
    const rows = await this.prisma.contentItem.findMany({
      where: {
        itemType: ContentItemType.emergency_guidance,
        reviewStatus: ContentReviewStatus.published,
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    if (rows.length === 0) {
      this.logger.warn(
        'No published emergency guidance. SRS 6.3 requires it to be persistently reachable.',
      );
    }
    return rows.map(publicDetail);
  }

  // -- Authoring, for admins ------------------------------------------------

  /** Everything, at any status. The authoring queue. */
  async listForAdmin(
    actor: AuthenticatedActor,
    filter: { itemType?: ContentItemType; reviewStatus?: ContentReviewStatus } = {},
  ): Promise<AdminContentItem[]> {
    assertPermission(actor, 'content', 'clinical_governance');
    const rows = await this.prisma.contentItem.findMany({
      where: {
        ...(filter.itemType ? { itemType: filter.itemType } : {}),
        ...(filter.reviewStatus ? { reviewStatus: filter.reviewStatus } : {}),
      },
      orderBy: [{ itemType: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: 300,
    });
    return rows.map(adminItem);
  }

  async getForAdmin(id: string, actor: AuthenticatedActor): Promise<AdminContentItem> {
    assertPermission(actor, 'content', 'clinical_governance');
    const found = await this.prisma.contentItem.findUnique({ where: { id } });
    if (!found) throw notFound();
    return adminItem(found);
  }

  /**
   * Author a new item. It starts as a DRAFT and reaches nobody.
   *
   * `content` writes; `clinical_governance` also may, because the reviewer
   * often fixes a sentence rather than sending the whole thing back.
   */
  async create(input: ContentInput, actor: AuthenticatedActor): Promise<AdminContentItem> {
    assertPermission(actor, 'content', 'clinical_governance');
    this.assertShapeIsCoherent(input);

    const created = await this.prisma.contentItem
      .create({ data: this.dataFrom(input) })
      .catch((error: unknown) => {
        throw slugTakenOr(error, input.slug);
      });

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'create',
      entityType: 'content_item',
      entityId: created.id,
      metadata: { itemType: created.itemType, slug: created.slug, status: 'draft' },
    });
    return adminItem(created);
  }

  /**
   * Edit.
   *
   * *** EDITING A PUBLISHED ITEM SENDS IT BACK FOR REVIEW. ***
   *
   * The point of a clinical review is that the words a patient reads are the
   * words a clinician approved. If an edit could leave an item published, the
   * review would attach to a version nobody is reading any more, and "reviewed
   * by" on the row would name somebody who never saw the current text.
   */
  async update(
    id: string,
    input: ContentInput,
    actor: AuthenticatedActor,
  ): Promise<AdminContentItem> {
    assertPermission(actor, 'content', 'clinical_governance');
    const existing = await this.requireExists(id);
    this.assertShapeIsCoherent(input);

    const wasPublished = existing.reviewStatus === ContentReviewStatus.published;
    const updated = await this.prisma.contentItem
      .update({
        where: { id },
        data: {
          ...this.dataFrom(input),
          ...(wasPublished
            ? {
                reviewStatus: ContentReviewStatus.in_clinical_review,
                reviewedByAdminId: null,
                reviewedAt: null,
              }
            : {}),
        },
      })
      .catch((error: unknown) => {
        throw slugTakenOr(error, input.slug);
      });

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'content_item',
      entityId: id,
      metadata: {
        slug: updated.slug,
        ...(wasPublished ? { unpublished: 'edited while published' } : {}),
      },
    });
    if (wasPublished) {
      this.logger.log(
        { id, slug: updated.slug },
        'Published item edited, so it returns to clinical review',
      );
    }
    return adminItem(updated);
  }

  /** Send a draft for the clinician to read. */
  async submitForReview(id: string, actor: AuthenticatedActor): Promise<AdminContentItem> {
    assertPermission(actor, 'content', 'clinical_governance');
    const existing = await this.requireExists(id);
    if (existing.reviewStatus === ContentReviewStatus.published) {
      throw notInState(existing.reviewStatus, 'sent for review');
    }

    const updated = await this.prisma.contentItem.update({
      where: { id },
      data: { reviewStatus: ContentReviewStatus.in_clinical_review },
    });
    await this.record(actor, id, { to: 'in_clinical_review' });
    return adminItem(updated);
  }

  /**
   * *** THE CLINICAL SIGN-OFF (FR-15.3, SRS 8). ***
   *
   * `clinical_governance` only. A content editor writes; a clinician decides
   * that what is written is safe to put in front of a patient, and those are
   * different judgements made by different people.
   *
   * The reviewer's name and the time go onto the row in the same write that
   * publishes it - a CHECK refuses a published row without them, so there is no
   * moment where content is live with nobody's name against it.
   */
  async publish(id: string, actor: AuthenticatedActor): Promise<AdminContentItem> {
    assertPermission(actor, 'clinical_governance');
    const existing = await this.requireExists(id);
    if (existing.reviewStatus === ContentReviewStatus.published) return adminItem(existing);

    const updated = await this.prisma.contentItem.update({
      where: { id },
      data: {
        reviewStatus: ContentReviewStatus.published,
        reviewedByAdminId: actor.id,
        reviewedAt: new Date(),
      },
    });
    await this.record(actor, id, { to: 'published', slug: updated.slug });
    return adminItem(updated);
  }

  /**
   * Retire an item.
   *
   * Archived, never deleted. A doctor may have recommended it last week, and a
   * Care Plan pointing at a row that no longer exists is a broken link on a
   * screen a patient was told to read.
   */
  async archive(id: string, actor: AuthenticatedActor): Promise<AdminContentItem> {
    assertPermission(actor, 'content', 'clinical_governance');
    await this.requireExists(id);
    const updated = await this.prisma.contentItem.update({
      where: { id },
      data: { reviewStatus: ContentReviewStatus.archived },
    });
    await this.record(actor, id, { to: 'archived', slug: updated.slug });
    return adminItem(updated);
  }

  // -- Internals ------------------------------------------------------------

  /**
   * The two rules the column types cannot carry.
   *
   * Checked here as well as by the CHECK, so the admin panel gets a sentence
   * rather than a constraint violation.
   */
  private assertShapeIsCoherent(input: ContentInput): void {
    const isOrg = input.itemType === ContentItemType.support_org;
    if (isOrg && input.isVerifiedOrg === undefined) {
      throw new AppException(
        ContentError.CONTENT_INVALID,
        'Say whether this organisation has been verified — FR-15.6 requires it shown to patients.',
        HttpStatus.BAD_REQUEST,
        { field: 'isVerifiedOrg' },
      );
    }
    if (!isOrg && input.isVerifiedOrg !== undefined && input.isVerifiedOrg !== null) {
      throw new AppException(
        ContentError.CONTENT_INVALID,
        'Only a support organisation can be marked verified.',
        HttpStatus.BAD_REQUEST,
        { field: 'isVerifiedOrg' },
      );
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.slug)) {
      throw new AppException(
        ContentError.CONTENT_INVALID,
        'The slug must be lowercase words separated by single hyphens — it goes into a link.',
        HttpStatus.BAD_REQUEST,
        { field: 'slug' },
      );
    }
  }

  private dataFrom(input: ContentInput) {
    return {
      itemType: input.itemType,
      slug: input.slug.trim(),
      title: input.title.trim(),
      summary: input.summary?.trim() || null,
      body: input.body as unknown as Prisma.InputJsonValue,
      concernId: input.concernId ?? null,
      specialtyId: input.specialtyId ?? null,
      coverStorageKey: input.coverStorageKey ?? null,
      isVerifiedOrg:
        input.itemType === ContentItemType.support_org ? (input.isVerifiedOrg ?? false) : null,
      sortOrder: input.sortOrder ?? 0,
    };
  }

  private async requireExists(id: string): Promise<ContentItem> {
    const found = await this.prisma.contentItem.findUnique({ where: { id } });
    if (!found) throw notFound();
    return found;
  }

  private async record(
    actor: AuthenticatedActor,
    id: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'content_item',
      entityId: id,
      metadata: metadata as Prisma.InputJsonValue,
    });
  }
}

function publicItem(row: ContentItem): PublicContentItem {
  return {
    id: row.id,
    itemType: row.itemType,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    concernId: row.concernId,
    specialtyId: row.specialtyId,
    coverStorageKey: row.coverStorageKey,
    isVerifiedOrg: row.isVerifiedOrg,
    sortOrder: row.sortOrder,
  };
}

function publicDetail(row: ContentItem): PublicContentDetail {
  return { ...publicItem(row), body: row.body };
}

/**
 * The admin view. Built by NAMING the review fields on top of the public one,
 * so a column added later is absent from what a patient sees until somebody
 * decides it belongs there.
 */
function adminItem(row: ContentItem): AdminContentItem {
  return {
    ...publicDetail(row),
    reviewStatus: row.reviewStatus,
    reviewedByAdminId: row.reviewedByAdminId,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function notFound(): AppException {
  return new AppException(
    ContentError.CONTENT_NOT_FOUND,
    'That item is not available.',
    HttpStatus.NOT_FOUND,
  );
}

function notInState(status: ContentReviewStatus, action: string): AppException {
  return new AppException(
    ContentError.NOT_IN_THAT_STATE,
    `An item that is ${status.replace(/_/g, ' ')} cannot be ${action}.`,
    HttpStatus.CONFLICT,
    { reviewStatus: status },
  );
}

/** A slug collision is a name clash, not a server error. P2002 says which. */
function slugTakenOr(error: unknown, slug: string): unknown {
  if ((error as { code?: string } | null)?.code === 'P2002') {
    return new AppException(
      ContentError.SLUG_TAKEN,
      `Another item already uses the slug "${slug}".`,
      HttpStatus.CONFLICT,
      { field: 'slug' },
    );
  }
  return error;
}
