import { ContentItemType, ContentReviewStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { ContentError } from './content.errors';
import { ContentInput, ContentService } from './content.service';

type Row = Record<string, unknown>;

const EDITOR: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'content' };
const GOVERNANCE: AuthenticatedActor = {
  type: 'admin',
  id: 'admin-2',
  level: 'clinical_governance',
};
const FINANCE: AuthenticatedActor = { type: 'admin', id: 'admin-3', level: 'finance' };

const item = (over: Row = {}) => ({
  id: 'item-1',
  itemType: ContentItemType.self_help_tool,
  slug: 'box-breathing',
  title: 'Box breathing',
  summary: 'A four-count breathing exercise for acute anxiety.',
  body: { blocks: [] },
  concernId: null,
  specialtyId: null,
  coverStorageKey: null,
  isVerifiedOrg: null,
  reviewStatus: ContentReviewStatus.draft,
  reviewedByAdminId: null,
  reviewedAt: null,
  sortOrder: 0,
  createdAt: new Date('2026-09-18T09:00:00.000Z'),
  updatedAt: new Date('2026-09-18T09:00:00.000Z'),
  ...over,
});

const TOOL: ContentInput = {
  itemType: ContentItemType.self_help_tool,
  slug: 'box-breathing',
  title: 'Box breathing',
  body: { blocks: [] },
};

function build(over: { item?: Row | null; rows?: Row[]; createThrows?: Error } = {}) {
  const current = over.item === undefined ? item() : over.item;

  const create = vi.fn<(args: { data: Row }) => Promise<Row>>().mockImplementation((args) => {
    if (over.createThrows) return Promise.reject(over.createThrows);
    return Promise.resolve(item(args.data));
  });
  const update = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(item({ ...(current ?? {}), ...args.data })));
  const findUnique = vi.fn<() => Promise<Row | null>>().mockResolvedValue(current);
  const findFirst = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(current);
  const findMany = vi
    .fn<(args: Row) => Promise<Row[]>>()
    .mockResolvedValue(over.rows ?? (current ? [current] : []));

  const prisma = {
    contentItem: { create, update, findUnique, findFirst, findMany },
  } as unknown as PrismaService;

  const audit = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);

  return {
    service: new ContentService(prisma, { record: audit } as unknown as AuditService),
    create,
    update,
    findFirst,
    findMany,
    audit,
  };
}

/**
 * *** THE PORT M-15 AND M-16 HAVE BEEN WAITING ON. ***
 * Until this module existed, a doctor's Care Hub picks were stored unchecked.
 */
describe('ContentService — the content library port', () => {
  it('accepts published ids as recommendable', async () => {
    const { service, findMany } = build();
    findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    await expect(service.unrecommendable(['a', 'b'])).resolves.toEqual([]);
  });

  /**
   * A draft is unfinished, one in review is not approved, and an archived item
   * was deliberately retired. Recommending any of the three would put a patient
   * in front of content nobody signed off.
   */
  it('only counts PUBLISHED items as recommendable', async () => {
    const { service, findMany } = build();
    findMany.mockResolvedValue([]);
    await service.unrecommendable(['a']);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      reviewStatus: ContentReviewStatus.published,
    });
  });

  /** Named, so the doctor can drop the offender rather than lose the selection. */
  it('names which ids cannot be recommended', async () => {
    const { service, findMany } = build();
    findMany.mockResolvedValue([{ id: 'good' }]);
    await expect(service.unrecommendable(['good', 'gone', 'draft'])).resolves.toEqual([
      'gone',
      'draft',
    ]);
  });

  it('asks nothing of the database for an empty selection', async () => {
    const { service, findMany } = build();
    await expect(service.unrecommendable([])).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('de-duplicates before asking', async () => {
    const { service, findMany } = build();
    findMany.mockResolvedValue([{ id: 'a' }]);
    await service.unrecommendable(['a', 'a', 'a']);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ id: { in: ['a'] } });
  });

  /**
   * *** THE ORDER IS THE CLINICIAN'S INTENT. *** `findMany` returns rows in
   * whatever order the index gives; a recommendation list is ordered by what
   * the doctor thought mattered most.
   */
  it('returns summaries in the order the doctor picked them', async () => {
    const { service, findMany } = build();
    findMany.mockResolvedValue([
      { id: 'b', slug: 'two', itemType: 'blog_article', title: 'Two', summary: null },
      { id: 'a', slug: 'one', itemType: 'self_help_tool', title: 'One', summary: null },
    ]);
    const resolved = await service.summaries(['a', 'b']);
    expect(resolved.map((row) => row.id)).toEqual(['a', 'b']);
  });

  /**
   * Archived items DO resolve here, unlike in `unrecommendable`. A doctor's
   * recommendation from last week should not vanish because the library was
   * tidied since — the patient was told to read it.
   */
  it('resolves without filtering on status, so a retired item still shows', async () => {
    const { service, findMany } = build();
    findMany.mockResolvedValue([]);
    await service.summaries(['a']);
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('reviewStatus');
  });

  /** Four of five recommendations beats a Care Plan that fails to load. */
  it('leaves out ids that no longer resolve, rather than failing', async () => {
    const { service, findMany } = build();
    findMany.mockResolvedValue([
      { id: 'a', slug: 'one', itemType: 'self_help_tool', title: 'One', summary: null },
    ]);
    await expect(service.summaries(['a', 'deleted'])).resolves.toHaveLength(1);
  });
});

describe('ContentService — what a patient sees', () => {
  it('reads only published items', async () => {
    const { service, findMany } = build();
    await service.shelf({ itemType: ContentItemType.self_help_tool });
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      reviewStatus: ContentReviewStatus.published,
      itemType: ContentItemType.self_help_tool,
    });
  });

  it('shelves in the order an admin set, then by age', async () => {
    const { service, findMany } = build();
    await service.shelf();
    expect(findMany.mock.calls[0][0].orderBy).toEqual([{ sortOrder: 'asc' }, { createdAt: 'asc' }]);
  });

  /** FR-15.6: a helpline list read by somebody in distress must be filterable. */
  it('can narrow the directory to verified organisations', async () => {
    const { service, findMany } = build();
    await service.shelf({ itemType: ContentItemType.support_org, verifiedOnly: true });
    expect(findMany.mock.calls[0][0].where).toMatchObject({ isVerifiedOrg: true });
  });

  it('never returns the review trail on a public read', async () => {
    const { service } = build({ item: item({ reviewStatus: ContentReviewStatus.published }) });
    const [shelved] = await service.shelf();
    expect(shelved).not.toHaveProperty('reviewStatus');
    expect(shelved).not.toHaveProperty('reviewedByAdminId');
  });

  it('refuses an item that is not published', async () => {
    const { service } = build({ item: null });
    await expect(service.bySlug('box-breathing')).rejects.toMatchObject({
      status: 404,
      response: { code: ContentError.CONTENT_NOT_FOUND },
    });
  });

  /**
   * *** SRS 6.3. *** A screen somebody in crisis is looking at must render. It
   * returns a list and never throws, so the app can fall back to built-in copy.
   */
  it('returns empty emergency guidance rather than failing', async () => {
    const { service, findMany } = build();
    findMany.mockResolvedValue([]);
    await expect(service.emergencyGuidance()).resolves.toEqual([]);
  });
});

describe('ContentService — authoring and clinical review', () => {
  it('creates as a draft, reaching nobody', async () => {
    const { service, create } = build();
    await service.create(TOOL, EDITOR);
    expect(create.mock.calls[0][0].data).toMatchObject({ slug: 'box-breathing' });
    // The column default is `draft`; nothing here sets a status.
    expect(create.mock.calls[0][0].data).not.toHaveProperty('reviewStatus');
  });

  /**
   * *** THE SIGN-OFF IS GOVERNANCE'S, NOT THE EDITOR'S. ***
   * A content editor writes; a clinician decides what is safe to put in front
   * of a patient. Different judgements, different people (FR-15.3, SRS 8).
   */
  it('lets a content editor write but not publish', async () => {
    const { service } = build();
    await expect(service.create(TOOL, EDITOR)).resolves.toMatchObject({ slug: 'box-breathing' });
    await expect(service.publish('item-1', EDITOR)).rejects.toMatchObject({ status: 403 });
  });

  it('stamps the reviewer and the time in the same write that publishes', async () => {
    const { service, update } = build({
      item: item({ reviewStatus: ContentReviewStatus.in_clinical_review }),
    });
    await service.publish('item-1', GOVERNANCE);
    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      reviewStatus: ContentReviewStatus.published,
      reviewedByAdminId: 'admin-2',
    });
    expect(data.reviewedAt).toBeInstanceOf(Date);
  });

  /**
   * *** EDITING A PUBLISHED ITEM SENDS IT BACK. ***
   *
   * The point of the review is that the words a patient reads are the words a
   * clinician approved. An edit that stayed published would leave "reviewed by"
   * naming somebody who never saw the current text.
   */
  it('un-publishes an item that is edited, and clears the reviewer', async () => {
    const { service, update } = build({
      item: item({
        reviewStatus: ContentReviewStatus.published,
        reviewedByAdminId: 'admin-2',
        reviewedAt: new Date(),
      }),
    });
    await service.update('item-1', { ...TOOL, title: 'Box breathing, revised' }, EDITOR);
    expect(update.mock.calls[0][0].data).toMatchObject({
      reviewStatus: ContentReviewStatus.in_clinical_review,
      reviewedByAdminId: null,
      reviewedAt: null,
    });
  });

  it('leaves a draft a draft when it is edited', async () => {
    const { service, update } = build();
    await service.update('item-1', { ...TOOL, title: 'Still a draft' }, EDITOR);
    expect(update.mock.calls[0][0].data).not.toHaveProperty('reviewStatus');
  });

  /**
   * Archived, never deleted. A doctor may have recommended it last week, and a
   * Care Plan pointing at a row that no longer exists is a broken link.
   */
  it('archives rather than deleting', async () => {
    const { service, update } = build({
      item: item({ reviewStatus: ContentReviewStatus.published }),
    });
    await service.archive('item-1', GOVERNANCE);
    expect(update.mock.calls[0][0].data).toEqual({
      reviewStatus: ContentReviewStatus.archived,
    });
  });

  it('refuses an admin whose level does not author content', async () => {
    const { service } = build();
    await expect(service.create(TOOL, FINANCE)).rejects.toMatchObject({ status: 403 });
    await expect(service.listForAdmin(FINANCE)).rejects.toMatchObject({ status: 403 });
  });

  it('reports a slug collision as a name clash, not a server error', async () => {
    const { service } = build({
      createThrows: Object.assign(new Error('unique'), { code: 'P2002' }),
    });
    await expect(service.create(TOOL, EDITOR)).rejects.toMatchObject({
      status: 409,
      response: { code: ContentError.SLUG_TAKEN },
    });
  });
});

/**
 * The two rules the column types cannot carry, checked in the service as well
 * as by a CHECK — so the admin panel gets a sentence rather than a constraint
 * violation.
 */
describe('ContentService — the shape has to hold together', () => {
  it('requires a verification answer on a support organisation (FR-15.6)', async () => {
    const { service, create } = build();
    await expect(
      service.create(
        { ...TOOL, itemType: ContentItemType.support_org, slug: 'city-helpline' },
        EDITOR,
      ),
    ).rejects.toMatchObject({ response: { code: ContentError.CONTENT_INVALID } });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to mark anything else verified', async () => {
    const { service } = build();
    await expect(service.create({ ...TOOL, isVerifiedOrg: true }, EDITOR)).rejects.toMatchObject({
      response: { code: ContentError.CONTENT_INVALID },
    });
  });

  it('accepts an organisation that says whether it was verified', async () => {
    const { service, create } = build();
    await service.create(
      {
        ...TOOL,
        itemType: ContentItemType.support_org,
        slug: 'city-helpline',
        isVerifiedOrg: false,
      },
      EDITOR,
    );
    expect(create.mock.calls[0][0].data).toMatchObject({ isVerifiedOrg: false });
  });

  /** Verification is null on everything that is not an organisation. */
  it('leaves verification null on ordinary content', async () => {
    const { service, create } = build();
    await service.create(TOOL, EDITOR);
    expect(create.mock.calls[0][0].data).toMatchObject({ isVerifiedOrg: null });
  });

  it.each(['Box Breathing', 'box_breathing', 'box--breathing', 'box breathing', '-leading'])(
    'refuses %o as a slug, because it goes into a link',
    async (slug) => {
      const { service } = build();
      await expect(service.create({ ...TOOL, slug }, EDITOR)).rejects.toMatchObject({
        response: { code: ContentError.CONTENT_INVALID },
      });
    },
  );
});
