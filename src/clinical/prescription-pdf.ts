import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

import { Medicine } from './completion';

/**
 * FR-9.5's PDF. Renders the closing record `ClinicalRecordsService.finalise`
 * has already written - this has no opinion of its own about what belongs on
 * it, only how to lay it out.
 *
 * Sent to the PATIENT it is about, so unlike every doctor-facing screen in
 * this codebase it names them - there is no de-identification concern in
 * handing somebody their own document.
 */
export interface PrescriptionPdfInput {
  referenceCode: string;
  issuedAt: Date;
  doctorName: string;
  doctorQualification: string | null;
  registrationNumber: string | null;
  patientName: string;
  patientAge: number | null;
  patientGender: string;
  diagnosis: string | null;
  isDiagnosisProvisional: boolean;
  medicines: Medicine[];
  advice: {
    covered: string | null;
    homePractice: string | null;
    nextFocus: string | null;
    warningSigns: string | null;
  };
  referralNote: string | null;
}

const PAGE_SIZE: [number, number] = [595.28, 841.89]; // A4, points
const MARGIN = 50;
const LINE_HEIGHT = 16;

export async function renderPrescriptionPdf(input: PrescriptionPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const writer = new PageWriter(doc, font, bold);

  writer.heading('Prescription');
  writer.line(`Reference: ${input.referenceCode}`, { size: 10 });
  writer.line(`Issued: ${input.issuedAt.toISOString().slice(0, 10)}`, { size: 10 });
  writer.gap();

  writer.subheading('Provider');
  writer.line(input.doctorName, { bold: true });
  if (input.doctorQualification) writer.line(input.doctorQualification);
  if (input.registrationNumber) writer.line(`Registration: ${input.registrationNumber}`);
  writer.gap();

  writer.subheading('Patient');
  writer.line(input.patientName, { bold: true });
  const ageGender = [
    input.patientAge !== null ? `${input.patientAge} years` : null,
    input.patientGender,
  ]
    .filter(Boolean)
    .join(', ');
  if (ageGender) writer.line(ageGender);
  writer.gap();

  if (input.diagnosis) {
    writer.subheading('Diagnosis');
    writer.paragraph(input.isDiagnosisProvisional ? `${input.diagnosis} (provisional)` : input.diagnosis);
    writer.gap();
  }

  if (input.medicines.length > 0) {
    writer.subheading('Medicines');
    for (const medicine of input.medicines) {
      writer.line(medicine.name, { bold: true });
      const line2 = [medicine.dose, medicine.frequency, medicine.duration].filter(Boolean).join(' · ');
      if (line2) writer.line(line2, { size: 10, indent: 12 });
      const line3 = [
        medicine.genericName ? `Generic: ${medicine.genericName}` : null,
        medicine.route ? `Route: ${medicine.route}` : null,
        medicine.quantity ? `Quantity: ${medicine.quantity}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      if (line3) writer.line(line3, { size: 10, indent: 12 });
      if (medicine.instructions) writer.paragraph(medicine.instructions, { size: 10, indent: 12 });
      writer.gap(6);
    }
    writer.gap();
  }

  const advice = [
    ['What was covered', input.advice.covered],
    ['Home practice', input.advice.homePractice],
    ['Next focus', input.advice.nextFocus],
    ['Warning signs', input.advice.warningSigns],
  ] as const;
  const hasAdvice = advice.some(([, text]) => text);
  if (hasAdvice) {
    writer.subheading('Advice and therapy plan');
    for (const [label, text] of advice) {
      if (!text) continue;
      writer.line(label, { bold: true, size: 11 });
      writer.paragraph(text, { size: 10, indent: 12 });
      writer.gap(6);
    }
    writer.gap();
  }

  if (input.referralNote) {
    writer.subheading('Referral');
    writer.paragraph(input.referralNote);
  }

  return doc.save();
}

/** Simple top-to-bottom layout with word wrap and page overflow. Nothing fancy. */
class PageWriter {
  private page: PDFPage;
  private y: number;

  constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.page = doc.addPage(PAGE_SIZE);
    this.y = PAGE_SIZE[1] - MARGIN;
  }

  heading(text: string): void {
    this.ensureRoom(24);
    this.page.drawText(text, { x: MARGIN, y: this.y, size: 20, font: this.bold });
    this.y -= 28;
  }

  subheading(text: string): void {
    this.ensureRoom(20);
    this.page.drawText(text, { x: MARGIN, y: this.y, size: 13, font: this.bold, color: rgb(0.2, 0.2, 0.2) });
    this.y -= 20;
  }

  line(text: string, opts: { bold?: boolean; size?: number; indent?: number } = {}): void {
    const size = opts.size ?? 12;
    this.ensureRoom(LINE_HEIGHT);
    this.page.drawText(text, {
      x: MARGIN + (opts.indent ?? 0),
      y: this.y,
      size,
      font: opts.bold ? this.bold : this.font,
    });
    this.y -= LINE_HEIGHT;
  }

  paragraph(text: string, opts: { size?: number; indent?: number } = {}): void {
    const size = opts.size ?? 12;
    const indent = opts.indent ?? 0;
    const maxWidth = PAGE_SIZE[0] - MARGIN * 2 - indent;
    for (const rawLine of text.split(/\r?\n/)) {
      for (const wrapped of wrap(rawLine, this.font, size, maxWidth)) {
        this.ensureRoom(LINE_HEIGHT);
        this.page.drawText(wrapped, { x: MARGIN + indent, y: this.y, size, font: this.font });
        this.y -= LINE_HEIGHT;
      }
    }
  }

  gap(amount = 12): void {
    this.y -= amount;
  }

  private ensureRoom(needed: number): void {
    if (this.y - needed < MARGIN) {
      this.page = this.doc.addPage(PAGE_SIZE);
      this.y = PAGE_SIZE[1] - MARGIN;
    }
  }
}

/** Greedy word wrap against the font's actual measured width. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [''];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
