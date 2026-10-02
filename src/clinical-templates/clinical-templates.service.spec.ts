import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from 'vitest';

import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { ClinicalTemplateError } from './clinical-templates.errors';
import { ClinicalTemplatesService, MAX_TEMPLATES_PER_DOCTOR } from './clinical-templates.service';
import { CreateTemplateDto } from './dto/clinical-templates.dto';

type Row = Record<string, any>;

const A: AuthenticatedActor = { type: 'doctor', id: 'doctor-a' };
const B: AuthenticatedActor = { type: 'doctor', id: 'doctor-b' };

const content = {
  meds: [{ name: 'Sertraline 50mg', dose: '1 tablet', frequency: 'Once daily', duration: '4 weeks' }],
  advice: ['Sleep on a schedule'],
  donts: ['Do not stop abruptly'],
};
const input = { name: '  Anxiety  ', kind: 'medication' as const, content };

/** An in-memory `clinicalTemplate` table that honours the `where` the service sends. */
function build() {
  const rows: Row[] = [];
  let n = 0;
  const match = (r: Row, w: Row) => Object.entries(w).every(([k, v]) => r[k] === v);
  const prisma = {
    clinicalTemplate: {
      findMany: async ({ where }: Row) => rows.filter((r) => match(r, where)),
      findFirst: async ({ where }: Row) => rows.find((r) => match(r, where)) ?? null,
      count: async ({ where }: Row) => rows.filter((r) => match(r, where)).length,
      create: async ({ data }: Row) => {
        const r = {
          id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(r);
        return r;
      },
      update: async ({ where, data }: Row) => Object.assign(rows.find((r) => r.id === where.id)!, data),
      delete: async ({ where }: Row) => {
        rows.splice(rows.findIndex((r) => r.id === where.id), 1);
      },
    },
  } as unknown as PrismaService;
  return { service: new ClinicalTemplatesService(prisma), rows };
}

describe('ClinicalTemplatesService', () => {
  it('creates, lists, updates and deletes', async () => {
    const { service } = build();
    const made = await service.create(input, A);
    expect(made).toMatchObject({ name: 'Anxiety', description: '', specialty: '', kind: 'medication' });

    expect(await service.list(A)).toHaveLength(1);
    const edited = await service.update(made.id, { name: 'Anxiety v2' }, A);
    expect(edited).toMatchObject({ name: 'Anxiety v2', kind: 'medication' });

    await service.remove(made.id, A);
    expect(await service.list(A)).toEqual([]);
  });

  it('keeps one doctor out of another doctor’s templates', async () => {
    const { service, rows } = build();
    const mine = await service.create(input, A);

    expect(await service.list(B)).toEqual([]);
    for (const attempt of [
      () => service.update(mine.id, { name: 'x' }, B),
      () => service.remove(mine.id, B),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: ClinicalTemplateError.TEMPLATE_NOT_FOUND });
    }
    expect(rows).toHaveLength(1);
  });

  it('reads a malformed id as not found', async () => {
    const { service } = build();
    await expect(service.remove('nope', A)).rejects.toMatchObject({
      code: ClinicalTemplateError.TEMPLATE_NOT_FOUND,
    });
  });

  it('refuses a non-doctor', async () => {
    const { service } = build();
    await expect(service.list({ type: 'patient', id: 'p' })).rejects.toMatchObject({
      code: ClinicalTemplateError.TEMPLATE_NOT_FOUND,
    });
  });

  it('caps templates per doctor, counting only their own', async () => {
    const { service } = build();
    for (let i = 0; i < MAX_TEMPLATES_PER_DOCTOR; i++) await service.create(input, A);
    await expect(service.create(input, A)).rejects.toMatchObject({
      code: ClinicalTemplateError.TEMPLATE_LIMIT_REACHED,
    });
    await expect(service.create(input, B)).resolves.toBeTruthy();
  });
});

describe('CreateTemplateDto', () => {
  const errors = async (over: Row) =>
    validate(plainToInstance(CreateTemplateDto, { ...input, ...over }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('accepts a valid body', async () => {
    expect(await errors({})).toEqual([]);
  });

  it.each([
    ['empty name', { name: '' }],
    ['name over 80', { name: 'x'.repeat(81) }],
    ['description over 300', { description: 'x'.repeat(301) }],
    ['unknown kind', { kind: 'other' }],
    ['31 advice lines', { content: { ...content, advice: Array(31).fill('a') } }],
    ['31 donts', { content: { ...content, donts: Array(31).fill('a') } }],
    ['31 medicines', { content: { ...content, meds: Array(31).fill(content.meds[0]) } }],
    ['an advice line over 500', { content: { ...content, advice: ['x'.repeat(501)] } }],
    ['a medicine missing its dose', { content: { ...content, meds: [{ name: 'A', frequency: 'b', duration: 'c' }] } }],
    ['an unexpected medicine field', { content: { ...content, meds: [{ ...content.meds[0], extra: 1 }] } }],
  ])('rejects %s', async (_label, over) => {
    expect((await errors(over)).length).toBeGreaterThan(0);
  });
});
