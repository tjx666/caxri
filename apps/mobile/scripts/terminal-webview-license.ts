const doctype = '<!doctype html>';
const commentLabel = 'Xterm license';
const commentPrefix = `\n<!-- ${commentLabel}\n`;
const commentSuffix = '-->';

/**
 * Embeds the exact upstream license bytes without allowing their contents to terminate the HTML comment.
 */
export const embedXtermLicenseComment = (html: string, license: Uint8Array): string => {
    if (!html.startsWith(doctype)) throw new Error('Terminal document must start with its doctype');
    if (html.includes(commentLabel))
        throw new Error('Terminal document already embeds the Xterm license');
    if (license.byteLength === 0) throw new Error('Xterm license must not be empty');

    let licenseText: string;
    try {
        licenseText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(license);
    } catch {
        throw new Error('Xterm license must be valid UTF-8');
    }
    if (licenseText.includes('\0')) throw new Error('Xterm license must not contain NUL bytes');
    if (licenseText.includes('--'))
        throw new Error('Xterm license must not contain an HTML comment boundary');

    return `${doctype}${commentPrefix}${licenseText}${commentSuffix}${html.slice(doctype.length)}`;
};
