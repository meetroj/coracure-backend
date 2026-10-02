import { HttpStatus, Injectable } from '@nestjs/common';
import { ClinicalTemplate, Prisma } from '@prisma/client';

import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { ClinicalTemplateError } from './clinical-templates.errors';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/clinical-templates.dto';

/** A guard on storage, not a clinical opinion. */
export const MAX_TEMPLATES_PER_DOCTOR = 50;

export interface TemplateView {
  id: string;
  name: string;
  description: string;
  kind: string;
  specialty: string;
  content: Prisma.JsonValue;
  createdAt: string;
  updatedAt: string;
}

const view = (t: ClinicalTemplate): TemplateView => ({
  id: t.id,
  name: t.name,
  description: t.description,
  kind: t.kind,
  specialty: t.specialty,
  content: t.content,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A doctor's own reusable templates. Every query is scoped by `doctorId`. */
@Injectable()
export class ClinicalTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: AuthenticatedActor): Promise<TemplateView[]> {
    const rows = await this.prisma.clinicalTemplate.findMany({
      where: { doctorId: doctorOf(actor) },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(view);
  }

  async create(dto: CreateTemplateDto, actor: AuthenticatedActor): Promise<TemplateView> {
    const doctorId = doctorOf(actor);
    // ponytail: count-then-insert can overshoot by a concurrent request or two; add a lock if it matters.
    if ((await this.prisma.clinicalTemplate.count({ where: { doctorId } })) >= MAX_TEMPLATES_PER_DOCTOR) {
      throw new AppException(
        ClinicalTemplateError.TEMPLATE_LIMIT_REACHED,
        `You can keep at most ${MAX_TEMPLATES_PER_DOCTOR} templates. Delete one to add another.`,
        HttpStatus.CONFLICT,
        { limit: MAX_TEMPLATES_PER_DOCTOR },
      );
    }
    const row = await this.prisma.clinicalTemplate.create({
      data: {
        doctorId,
        name: dto.name.trim(),
        description: dto.description?.trim() ?? '',
        kind: dto.kind,
        specialty: dto.specialty?.trim() ?? '',
        content: dto.content as unknown as Prisma.InputJsonValue,
      },
    });
    return view(row);
  }

  async update(id: string, dto: UpdateTemplateDto, actor: AuthenticatedActor): Promise<TemplateView> {
    await this.requireOwn(id, doctorOf(actor));
    const row = await this.prisma.clinicalTemplate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.description !== undefined && { description: dto.description.trim() }),
        ...(dto.kind !== undefined && { kind: dto.kind }),
        ...(dto.specialty !== undefined && { specialty: dto.specialty.trim() }),
        ...(dto.content !== undefined && { content: dto.content as unknown as Prisma.InputJsonValue }),
      },
    });
    return view(row);
  }

  async remove(id: string, actor: AuthenticatedActor): Promise<void> {
    await this.requireOwn(id, doctorOf(actor));
    await this.prisma.clinicalTemplate.delete({ where: { id } });
  }

  private async requireOwn(id: string, doctorId: string) {
    // A non-uuid id must read as "not found", not a database error.
    const row = UUID.test(id)
      ? await this.prisma.clinicalTemplate.findFirst({ where: { id, doctorId } })
      : null;
    if (!row) throw notFound();
    return row;
  }
}

function doctorOf(actor: AuthenticatedActor): string {
  if (actor.type !== 'doctor') throw notFound();
  return actor.id;
}

function notFound(): AppException {
  return new AppException(
    ClinicalTemplateError.TEMPLATE_NOT_FOUND,
    'Template not found.',
    HttpStatus.NOT_FOUND,
  );
}
