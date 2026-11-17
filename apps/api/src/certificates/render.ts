import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, degrees, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import {
  CERT_ACCENTS,
  CERT_KIND_TITLE,
  TRAINER_CERT_SIGNATORY,
  DEFAULT_CERT_MESSAGE,
  type CertKind,
  type CertificateTemplate,
} from '@assessiq/shared';
import { NANDIVEX_LOGO_BASE64 } from './nandivex-logo';

export interface CertificateFacts {
  holderName: string;
  examTitle: string;
  orgName: string | null;
  kind: CertKind;
  scorePercent: number;
  /** Trainer certificates: how many students took the exam. */
  participants?: number | null;
  /** Draws a faint SAMPLE mark across it (previews and website samples). */
  sample?: boolean;
  issuedOn: Date;
  serialNo: string;
  verifyUrl: string;
}

const W = 841.89; // A4 landscape, points
const H = 595.28;

const hexToRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
const GREY = rgb(0.38, 0.4, 0.45);
// NandiVex palette (nandivex.in): deep purple text, orange as the small highlight.
const INK = rgb(0x2a / 255, 0x1b / 255, 0x47 / 255);
const ORANGE = rgb(1, 0xb0 / 255, 0x20 / 255);

/** The built-in PDF fonts only cover Latin text; anything else is shown as "?" instead of failing. */
function safe(font: PDFFont, s: string): string {
  let out = '';
  for (const ch of s.replace(/[\r\n\t]+/g, ' ')) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

function fit(font: PDFFont, text: string, size: number, maxWidth: number, min = 10): number {
  let s = size;
  while (s > min && font.widthOfTextAtSize(text, s) > maxWidth) s -= 1;
  return s;
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number, maxLines: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && font.widthOfTextAtSize(last + '…', size) > maxWidth) {
      last = last.slice(0, -1);
    }
    kept[maxLines - 1] = last.replace(/\s+$/, '') + '...';
    return kept;
  }
  return lines;
}

async function embedImage(doc: PDFDocument, bytes: Buffer | null): Promise<PDFImage | null> {
  if (!bytes) return null;
  try {
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    return png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    return null; // a broken logo must not stop the certificate
  }
}

function drawImageFit(
  page: PDFPage,
  img: PDFImage,
  box: { x: number; y: number; w: number; h: number },
  align: 'left' | 'right' | 'center' = 'left',
) {
  const scale = Math.min(box.w / img.width, box.h / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const x =
    align === 'left' ? box.x : align === 'right' ? box.x + box.w - w : box.x + (box.w - w) / 2;
  page.drawImage(img, { x, y: box.y + (box.h - h) / 2, width: w, height: h });
}

const longDate = (d: Date) =>
  d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

/**
 * Draws one certificate as an A4 landscape PDF: the trainer's logo and the NandiVex logo, the
 * holder, the exam, a signature line, the serial number and a QR code that opens the public
 * verification page.
 */
export async function renderCertificate(input: {
  facts: CertificateFacts;
  template: CertificateTemplate;
  trainerLogo: Buffer | null;
}): Promise<Buffer> {
  const { facts, template } = input;
  const doc = await PDFDocument.create();
  doc.setTitle(`${CERT_KIND_TITLE[facts.kind]} - ${facts.serialNo}`);
  doc.setAuthor('Parakh by NandiVex Technologies');
  doc.setProducer('Parakh');
  const page = doc.addPage([W, H]);

  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const serif = await doc.embedFont(StandardFonts.TimesRomanBoldItalic);
  const accent = hexToRgb(CERT_ACCENTS[template.accent].hex);
  const classic = template.layout === 'CLASSIC';

  const nandivex = await embedImage(doc, Buffer.from(NANDIVEX_LOGO_BASE64, 'base64'));
  const trainer = await embedImage(doc, input.trainerLogo);
  const qr = await embedImage(
    doc,
    await QRCode.toBuffer(facts.verifyUrl, { margin: 1, width: 300, errorCorrectionLevel: 'M' }),
  );

  // ---- frame
  const left = classic ? 70 : 110; // text starts here
  const right = W - 70;
  if (classic) {
    page.drawRectangle({
      x: 24,
      y: 24,
      width: W - 48,
      height: H - 48,
      borderColor: accent,
      borderWidth: 3,
    });
    page.drawRectangle({
      x: 34,
      y: 34,
      width: W - 68,
      height: H - 68,
      borderColor: accent,
      borderWidth: 0.8,
    });
  } else {
    page.drawRectangle({ x: 0, y: 0, width: 58, height: H, color: accent });
    page.drawRectangle({ x: 58, y: 0, width: 6, height: H, color: ORANGE });
  }

  // ---- logos: trainer on the left, NandiVex on the right
  const top = H - 118;
  if (trainer) drawImageFit(page, trainer, { x: left, y: top, w: 120, h: 70 }, 'left');
  if (nandivex) drawImageFit(page, nandivex, { x: right - 120, y: top, w: 120, h: 70 }, 'right');
  const org = facts.orgName ? safe(regular, facts.orgName) : '';
  if (org && !trainer) {
    page.drawText(org, {
      x: left,
      y: top + 28,
      size: fit(bold, org, 16, 300),
      font: bold,
      color: accent,
    });
  }

  // ---- heading
  const centerX = (text: string, font: PDFFont, size: number) =>
    (W - font.widthOfTextAtSize(text, size)) / 2;
  const place = (text: string, font: PDFFont, size: number) =>
    classic ? centerX(text, font, size) : left;
  const heading = safe(bold, (template.title ?? CERT_KIND_TITLE[facts.kind]).toUpperCase());
  const headSize = fit(bold, heading, 30, W - left - 90, 16);
  let y = H - 190;
  page.drawText(heading, {
    x: place(heading, bold, headSize),
    y,
    size: headSize,
    font: bold,
    color: accent,
  });

  // A short orange rule under the heading, the NandiVex highlight colour.
  const ruleW = 56;
  page.drawRectangle({
    x: classic ? (W - ruleW) / 2 : left,
    y: y - 14,
    width: ruleW,
    height: 3,
    color: ORANGE,
  });

  y -= 36;
  const intro = 'This is to certify that';
  page.drawText(intro, { x: place(intro, regular, 13), y, size: 13, font: regular, color: GREY });

  // ---- holder name
  y -= 52;
  const name = safe(serif, facts.holderName);
  const nameSize = fit(serif, name, 42, W - left - 90, 18);
  page.drawText(name, {
    x: place(name, serif, nameSize),
    y,
    size: nameSize,
    font: serif,
    color: INK,
  });
  const nameWidth = serif.widthOfTextAtSize(name, nameSize);
  const lineX = classic ? (W - Math.max(nameWidth, 260)) / 2 : left;
  page.drawLine({
    start: { x: lineX, y: y - 10 },
    end: { x: lineX + Math.max(nameWidth, 260), y: y - 10 },
    thickness: 0.8,
    color: accent,
  });

  // ---- message and exam
  y -= 42;
  const message = safe(regular, template.message ?? DEFAULT_CERT_MESSAGE[facts.kind]);
  page.drawText(message, {
    x: place(message, regular, 14),
    y,
    size: 14,
    font: regular,
    color: INK,
  });
  y -= 30;
  const examLines = wrap(bold, safe(bold, facts.examTitle), 22, W - left - 120, 2);
  for (const line of examLines) {
    page.drawText(line, { x: place(line, bold, 22), y, size: 22, font: bold, color: INK });
    y -= 28;
  }
  const detail =
    facts.kind === 'TRAINER'
      ? `${facts.participants ?? 0} student${facts.participants === 1 ? '' : 's'} took the exam   |   Issued ${longDate(facts.issuedOn)}`
      : `Score ${Math.round(facts.scorePercent * 10) / 10}%   |   Issued ${longDate(facts.issuedOn)}`;
  page.drawText(detail, {
    x: place(detail, regular, 12),
    y: y - 4,
    size: 12,
    font: regular,
    color: GREY,
  });

  // ---- signature line (bottom left)
  const sigX = left;
  const sigY = 112;
  page.drawLine({
    start: { x: sigX, y: sigY },
    end: { x: sigX + 200, y: sigY },
    thickness: 0.8,
    color: INK,
  });
  // A student's certificate is signed as the trainer chose; the trainer's own is signed by NandiVex.
  const signatory =
    facts.kind === 'TRAINER'
      ? TRAINER_CERT_SIGNATORY
      : { name: template.signatoryName, title: template.signatoryTitle };
  const sigName = signatory.name ? safe(bold, signatory.name) : '';
  const sigTitle = signatory.title ? safe(regular, signatory.title) : '';
  let sy = sigY - 15;
  if (sigName) {
    page.drawText(sigName, {
      x: sigX,
      y: sy,
      size: fit(bold, sigName, 12, 200),
      font: bold,
      color: INK,
    });
    sy -= 14;
  }
  if (sigTitle) {
    page.drawText(sigTitle, {
      x: sigX,
      y: sy,
      size: fit(regular, sigTitle, 10, 200),
      font: regular,
      color: GREY,
    });
  }
  if (!sigName && !sigTitle) {
    page.drawText('Authorised signatory', { x: sigX, y: sy, size: 10, font: regular, color: GREY });
  }

  // ---- QR and serial (bottom right)
  const qrSize = 86;
  if (qr) page.drawImage(qr, { x: right - qrSize, y: 62, width: qrSize, height: qrSize });
  const serial = `Serial ${facts.serialNo}`;
  const ss = 10;
  const mid = (left + right - qrSize) / 2 + (classic ? 0 : 60);
  page.drawText(serial, {
    x: mid - bold.widthOfTextAtSize(serial, ss) / 2,
    y: 100,
    size: ss,
    font: bold,
    color: INK,
  });
  const verify = safe(regular, `Verify at ${facts.verifyUrl.replace(/^https?:\/\//, '')}`);
  const vs = fit(regular, verify, 9, 330, 6);
  page.drawText(verify, {
    x: mid - regular.widthOfTextAtSize(verify, vs) / 2,
    y: 86,
    size: vs,
    font: regular,
    color: GREY,
  });
  const issuer = 'Issued through Parakh by NandiVex Technologies';
  page.drawText(issuer, {
    x: mid - regular.widthOfTextAtSize(issuer, 8) / 2,
    y: 72,
    size: 8,
    font: regular,
    color: GREY,
  });

  if (facts.sample) {
    const mark = 'SAMPLE';
    const size = 120;
    page.drawText(mark, {
      x: W / 2 - (bold.widthOfTextAtSize(mark, size) / 2) * Math.cos(Math.PI / 7),
      y: H / 2 - 100,
      size,
      font: bold,
      color: INK,
      opacity: 0.07,
      rotate: degrees(26),
    });
  }

  return Buffer.from(await doc.save());
}
