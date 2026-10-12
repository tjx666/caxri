import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

/**
 * The 32-byte padding string the PDF standard security handler appends to every password (ISO 32000-1, 7.6.3.3).
 */
const PASSWORD_PADDING = Buffer.from(
    '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
    'hex',
);

/**
 * Fixed rather than random so the fixture is reproducible; any 16 bytes work as the document ID.
 */
const DOCUMENT_ID = Buffer.from('caxri-synthetic!', 'latin1');

/**
 * Permission flags with every operation allowed: the bits the standard requires set, plus all permission bits.
 */
const ALL_PERMISSIONS = -4;

function md5(...parts: Buffer[]): Buffer {
    const hash = createHash('md5');
    for (const part of parts) hash.update(part);
    return hash.digest();
}

/**
 * RC4, written out because OpenSSL 3 ships it only in its legacy provider.
 */
function swap(state: number[], first: number, second: number): void {
    const value = state[first];
    state[first] = state[second];
    state[second] = value;
}

function rc4(key: Buffer, data: Buffer): Buffer {
    const state = Array.from({ length: 256 }, (_, index) => index);
    let mixed = 0;
    for (let index = 0; index < 256; index++) {
        mixed = (mixed + state[index] + key[index % key.length]) % 256;
        swap(state, index, mixed);
    }
    const output = Buffer.alloc(data.length);
    let counter = 0;
    mixed = 0;
    for (const [index, byte] of data.entries()) {
        counter = (counter + 1) % 256;
        mixed = (mixed + state[counter]) % 256;
        swap(state, counter, mixed);
        output[index] = byte ^ state[(state[counter] + state[mixed]) % 256];
    }
    return output;
}

function padPassword(password: string): Buffer {
    return Buffer.concat([Buffer.from(password, 'latin1'), PASSWORD_PADDING]).subarray(0, 32);
}

/**
 * The 40-bit RC4 (revision 2) standard security handler: the `/Encrypt` dictionary for `userPassword` and a function
 * that encrypts one object's stream. Revision 2 is the simplest scheme every reader still opens, and the fixture only
 * has to prove that the preview asks for, rejects, and accepts a password.
 */
function standardSecurityHandler(userPassword: string): {
    dictionary: string;
    encryptStream: (objectId: number, data: Buffer) => Buffer;
} {
    const owner = rc4(
        md5(padPassword(`${userPassword}-owner`)).subarray(0, 5),
        padPassword(userPassword),
    );
    const permissions = Buffer.alloc(4);
    permissions.writeInt32LE(ALL_PERMISSIONS);
    const fileKey = md5(padPassword(userPassword), owner, permissions, DOCUMENT_ID).subarray(0, 5);
    const user = rc4(fileKey, PASSWORD_PADDING);
    return {
        dictionary: `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P ${ALL_PERMISSIONS} >>`,
        encryptStream: (objectId, data) => {
            const objectKey = Buffer.alloc(5);
            objectKey.writeUIntLE(objectId, 0, 3);
            return rc4(md5(fileKey, objectKey).subarray(0, 10), data);
        },
    };
}

/**
 * Builds a small, valid PDF with one line of text per page, set in the non-embedded Helvetica standard font.
 *
 * Generated rather than committed so the fixture is plainly synthetic and its content is readable in the spec. pdf.js
 * draws the non-embedded font with a local system font, so the text layer is real without any embedded font data.
 *
 * With `userPassword` the page streams are encrypted and a reader must be given that password to open the file.
 */
export function syntheticPdf(
    pageTexts: readonly string[],
    { userPassword }: { userPassword?: string } = {},
): Buffer {
    const security = userPassword === undefined ? undefined : standardSecurityHandler(userPassword);
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
        const content =
            security?.encryptStream(pageId + 1, Buffer.from(stream, 'latin1')).toString('latin1') ??
            stream;
        objects.set(pageId + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    }
    const encryptId = objects.size + 1;
    if (security) objects.set(encryptId, security.dictionary);

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
    const encryption = security
        ? ` /Encrypt ${encryptId} 0 R /ID [<${DOCUMENT_ID.toString('hex')}> <${DOCUMENT_ID.toString('hex')}>]`
        : '';
    body += `trailer\n<< /Size ${count + 1} /Root 1 0 R${encryption} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(body, 'latin1');
}
