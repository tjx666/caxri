const CHUNK_LENGTH = 24_000;
const MAX_BASE64_LENGTH = 4 * 1_024 * 1_024;

export function splitMobileImage(base64: string): string[] {
    const encoded = base64.replace(/^data:image\/jpeg;base64,/u, '').replaceAll(/\s+/gu, '');
    if (encoded.length === 0 || encoded.length > MAX_BASE64_LENGTH)
        throw new Error('Images can be at most 3 MB after compression.');
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
        throw new Error('This image could not be prepared for upload.');
    const chunks: string[] = [];
    for (let offset = 0; offset < encoded.length; offset += CHUNK_LENGTH)
        chunks.push(encoded.slice(offset, offset + CHUNK_LENGTH));
    if (chunks.length > 192) throw new Error('Image requires too many upload chunks.');
    return chunks;
}
