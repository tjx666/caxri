import { Buffer } from 'node:buffer';

/**
 * Builds a small, valid PDF with one line of text per page, set in the non-embedded Helvetica standard font.
 *
 * Generated rather than committed so the fixture is plainly synthetic and its content is readable in the spec. pdf.js
 * draws the non-embedded font with a local system font, so the text layer is real without any embedded font data.
 */
export function syntheticPdf(pageTexts: readonly string[]): Buffer {
    const fontId = 3;
    const firstPageId = 4;
    const pageIds = pageTexts.map((_, index) => firstPageId + index * 2);
    const objects = new Map<number, string>([
        [1, '<< /Type /Catalog /Pages 2 0 R >>'],
        [
            2,
            `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
        ],
        [fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    ]);
    for (const [index, text] of pageTexts.entries()) {
        const pageId = pageIds[index];
        const stream = `BT /F1 24 Tf 72 720 Td (${text.replaceAll(/[()\\]/gu, (character) => `\\${character}`)}) Tj ET`;
        objects.set(
            pageId,
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
        );
        objects.set(pageId + 1, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    }

    let body = '%PDF-1.7\n';
    const offsets: number[] = [];
    const count = objects.size;
    for (let id = 1; id <= count; id++) {
        offsets[id] = body.length;
        body += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
    }
    const xrefOffset = body.length;
    body += `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= count; id++)
        body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    body += `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(body, 'latin1');
}
