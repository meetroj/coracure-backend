import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import { ContentService } from './content.service';
import { AdminContentQueryDto, ContentInputDto, ShelfQueryDto } from './dto/content.dto';

/**
 * The Care Hub, as a patient or a doctor reads it (FR-15.1 to FR-15.7).
 *
 * *** PUBLISHED ONLY, AND NO OWNERSHIP CHECK ANYWHERE. ***
 *
 * This library holds no clinical data and belongs to no patient, so there is
 * nobody it could be scoped to — a breathing exercise is the same breathing
 * exercise for everybody. The routes are authenticated because an app with no
 * session has nowhere to show them, not because the content is private.
 *
 * Open to doctors as well as patients: a doctor picking items to recommend
 * after a consult (FR-15.4) is reading the same shelf the patient will.
 */
@ApiTags('care-hub')
@ApiBearerAuth()
@Roles('patient', 'doctor')
@Controller({ path: 'care-hub', version: '1' })
export class CareHubController {
  constructor(private readonly content: ContentService) {}

  @Get('items')
  @ApiOperation({
    summary: 'A shelf of the library (FR-15.1 to FR-15.6)',
    description:
      'Published items only, in the order an admin set. Filter by `itemType` for the self-help tools, the education library, the blogs, the caregiver guides or the support directory; by `concernId` for condition-wise shelving; and by `verifiedOnly` for FR-15.6’s verified organisations.',
  })
  shelf(@Query() query: ShelfQueryDto) {
    return this.content.shelf(query);
  }

  @Get('emergency')
  @ApiOperation({
    summary: 'Emergency guidance (FR-15.7, SRS 6.3)',
    description:
      'Persistent and reachable from everywhere. Returns a list and never fails when it is empty — a screen somebody in crisis is looking at must render, so the app falls back to its built-in copy rather than showing an error.',
  })
  emergency() {
    return this.content.emergencyGuidance();
  }

  @Get('items/:slug')
  @ApiOperation({
    summary: 'One item, in full',
    description:
      'By slug rather than id, so a deep link survives a re-title and a support script can name an article in words.',
  })
  item(@Param('slug') slug: string) {
    return this.content.bySlug(slug);
  }
}

/**
 * Authoring and clinical review (M-18's completion criterion: all content is
 * admin-published without a release).
 *
 * Two roles, deliberately split. `content` writes; `clinical_governance`
 * decides that what is written is safe to put in front of a patient. Publishing
 * is governance-only, because those are different judgements — and a CHECK
 * refuses a published row with no named reviewer, so there is no moment where
 * content is live with nobody's name against it.
 */
@ApiTags('admin/care-hub')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/care-hub', version: '1' })
export class AdminCareHubController {
  constructor(private readonly content: ContentService) {}

  @Get('items')
  @ApiOperation({ summary: 'The authoring queue, at any status' })
  list(@Query() query: AdminContentQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.content.listForAdmin(actor, query);
  }

  @Get('items/:id')
  @ApiOperation({ summary: 'One item, with its review trail' })
  get(@Param('id') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.content.getForAdmin(id, actor);
  }

  @Post('items')
  @ApiOperation({
    summary: 'Write a new item',
    description: 'Starts as a draft and reaches nobody until a clinician publishes it.',
  })
  create(@Body() dto: ContentInputDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.content.create(dto, actor);
  }

  @Patch('items/:id')
  @ApiOperation({
    summary: 'Edit an item',
    description:
      'Editing a PUBLISHED item sends it back to clinical review and clears the reviewer. The point of the review is that the words a patient reads are the words a clinician approved — an edit that stayed published would leave the sign-off attached to text nobody is reading any more.',
  })
  update(
    @Param('id') id: string,
    @Body() dto: ContentInputDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.content.update(id, dto, actor);
  }

  @Post('items/:id/submit')
  @ApiOperation({ summary: 'Send a draft for clinical review' })
  submit(@Param('id') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.content.submitForReview(id, actor);
  }

  @Post('items/:id/publish')
  @ApiOperation({
    summary: 'Clinical sign-off, and publish (FR-15.3, SRS 8)',
    description:
      'Clinical governance only. The reviewer’s name and the time go onto the row in the same write that publishes it.',
  })
  publish(@Param('id') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.content.publish(id, actor);
  }

  @Post('items/:id/archive')
  @ApiOperation({
    summary: 'Retire an item',
    description:
      'Archived, never deleted. A doctor may have recommended it last week, and a Care Plan pointing at a row that no longer exists is a broken link on a screen a patient was told to read.',
  })
  archive(@Param('id') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.content.archive(id, actor);
  }
}
