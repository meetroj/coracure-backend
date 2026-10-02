import { HttpStatus, Injectable } from '@nestjs/common';

import { AppConfigService } from '../app-config/app-config.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import {
  EditableTemplate,
  FORBIDDEN_TERMS,
  FORBIDDEN_TERMS_KEY,
  NOTIFICATION_TEMPLATES,
  Placeholder,
  TEMPLATES_KEY,
  TemplateDefinition,
  defaultTemplateCopy,
  editableTemplateSchema,
  forbiddenTermsSchema,
  templateDefinition,
  templatesConfigSchema,
} from './notification-templates';
import { NotificationsError } from './notifications.errors';

/** A template as the admin panel shows it: the copy, plus what it may use. */
export interface TemplateRecord extends EditableTemplate {
  code: string;
  description: string;
  audience: string[];
  placeholders: string[];
  /** False once an admin has edited it away from what shipped. */
  isDefault: boolean;
}

export interface RenderedCopy {
  title: string;
  body: string;
}

/** `{{name}}`, and nothing cleverer. No logic in copy an admin can edit. */
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * The copy, and the rules about it.
 *
 * FR-16.3 makes notification wording admin-editable, so it is an `app_config`
 * value rather than anything in the build - the client rewords a reminder and
 * every app sees it within the config cache window, with no release.
 *
 * What an admin CANNOT do is as important as what they can. They may not add a
 * variable a template does not carry, and they may not write copy that names a
 * diagnosis (FR-16.2). Both are refused at save time, so bad wording is caught
 * where somebody is looking at a screen rather than at 2am on ten thousand
 * lock screens.
 */
@Injectable()
export class NotificationTemplatesService {
  constructor(private readonly config: AppConfigService) {}

  /** Everything the panel lists, shipped copy merged with whatever was edited. */
  async list(): Promise<TemplateRecord[]> {
    const stored = await this.storedCopy();
    return NOTIFICATION_TEMPLATES.map((definition) => {
      const copy = stored[definition.code];
      return {
        code: definition.code,
        description: definition.description,
        audience: definition.audience,
        placeholders: definition.placeholders,
        title: copy?.title ?? definition.title,
        body: copy?.body ?? definition.body,
        isDefault:
          copy === undefined || (copy.title === definition.title && copy.body === definition.body),
      };
    });
  }

  async get(code: string): Promise<TemplateRecord> {
    const found = (await this.list()).find((template) => template.code === code);
    if (!found) throw unknownTemplate(code);
    return found;
  }

  /**
   * Edits one template's wording (FR-16.3).
   *
   * The checks run BEFORE the write, so a rejected edit changes nothing: the
   * previous copy stays live rather than the platform falling back to a
   * half-saved template on the next send.
   */
  async update(
    code: string,
    copy: EditableTemplate,
    actor: AuthenticatedActor,
  ): Promise<TemplateRecord> {
    const definition = templateDefinition(code);
    if (!definition) throw unknownTemplate(code);

    const parsed = editableTemplateSchema.parse(copy);
    this.assertPlaceholdersAreKnown(parsed, definition);
    await this.assertNamesNoDiagnosis(`${parsed.title}\n${parsed.body}`, 'template copy');

    const stored = await this.storedCopy();
    await this.config.set(
      TEMPLATES_KEY,
      { ...stored, [code]: parsed },
      { type: actor.type, id: actor.id },
    );
    return this.get(code);
  }

  /** Puts a template back to the wording that shipped. */
  async resetToDefault(code: string, actor: AuthenticatedActor): Promise<TemplateRecord> {
    const definition = templateDefinition(code);
    if (!definition) throw unknownTemplate(code);

    const stored = await this.storedCopy();
    await this.config.set(
      TEMPLATES_KEY,
      { ...stored, [code]: { title: definition.title, body: definition.body } },
      { type: actor.type, id: actor.id },
    );
    return this.get(code);
  }

  /**
   * Fills a template in.
   *
   * A variable the caller did not supply is a bug in the calling module, and the
   * result would be a message with a hole in it - "Your consultation with  is
   * confirmed". That is worse than no message, so it throws here and
   * `NotificationsService` turns it into a refusal that reaches the error log
   * rather than the patient.
   */
  async render(code: string, variables: Record<string, string>): Promise<RenderedCopy> {
    const template = await this.get(code);
    const rendered = {
      title: fill(template.title, variables, code),
      body: fill(template.body, variables, code),
    };

    // Checked again on the RESULT, not just on the copy. A template can be
    // spotless and still produce "Your Depression Therapy consultation" once a
    // service name is substituted in, and FR-16.2 is about what the recipient
    // reads.
    await this.assertNamesNoDiagnosis(`${rendered.title}\n${rendered.body}`, 'notification text');
    return rendered;
  }

  /** The terms an admin may add to, held as configuration for the same reason the copy is. */
  async forbiddenTerms(): Promise<string[]> {
    return (await this.config.get(FORBIDDEN_TERMS_KEY, forbiddenTermsSchema)) ?? FORBIDDEN_TERMS;
  }

  private assertPlaceholdersAreKnown(copy: EditableTemplate, definition: TemplateDefinition): void {
    const allowed = new Set<string>(definition.placeholders as readonly string[] as string[]);
    const used = new Set([...placeholdersIn(copy.title), ...placeholdersIn(copy.body)]);
    const unknown = [...used].filter((name) => !allowed.has(name));
    if (unknown.length > 0) {
      throw new AppException(
        NotificationsError.UNKNOWN_PLACEHOLDER,
        `This template does not carry ${unknown.map((name) => `{{${name}}}`).join(', ')}. It can use: ${
          definition.placeholders.length > 0
            ? definition.placeholders.map((name) => `{{${name}}}`).join(', ')
            : 'no variables at all'
        }.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** *** FR-16.2 *** Notification text never names a diagnosis. */
  private async assertNamesNoDiagnosis(text: string, what: string): Promise<void> {
    const offending = findForbiddenTerm(text, await this.forbiddenTerms());
    if (offending) {
      throw new AppException(
        NotificationsError.CLINICAL_TERM_IN_COPY,
        `A notification never names a diagnosis (FR-16.2), and this ${what} contains "${offending}". Say that something needs attention, and let the app show what.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async storedCopy(): Promise<Record<string, EditableTemplate>> {
    return (await this.config.get(TEMPLATES_KEY, templatesConfigSchema)) ?? defaultTemplateCopy();
  }
}

function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
}

function fill(text: string, variables: Record<string, string>, code: string): string {
  return text.replace(PLACEHOLDER_PATTERN, (_whole, name: string) => {
    const value = variables[name];
    if (value === undefined || value === '') {
      throw new AppException(
        NotificationsError.UNKNOWN_PLACEHOLDER,
        `Notification "${code}" needs a value for {{${name}}}.`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return value;
  });
}

/**
 * Whole words only, case-insensitive. Matching anywhere would catch "OCD" inside
 * an ordinary word and block copy that says nothing clinical, and a rule that
 * fires on innocent wording is one an operator learns to route around.
 */
export function findForbiddenTerm(text: string, terms: string[]): string | undefined {
  const haystack = text.toLowerCase();
  return terms.find((term) => {
    const needle = term.toLowerCase().trim();
    if (!needle) return false;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) return false;
      const before = haystack[at - 1];
      const after = haystack[at + needle.length];
      if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
      from = at + 1;
    }
  });
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[a-z0-9]/i.test(character);
}

function unknownTemplate(code: string): AppException {
  return new AppException(
    NotificationsError.TEMPLATE_NOT_FOUND,
    `There is no notification template "${code}".`,
    HttpStatus.NOT_FOUND,
  );
}

export type { EditableTemplate, Placeholder };
