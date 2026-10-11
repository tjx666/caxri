import createMarkdownIt from 'markdown-it';

/**
 * One web link found in plain prose.
 */
export interface ProseWebLink {
    /**
     * Offset of the link in the scanned text.
     */
    index: number;
    /**
     * The link exactly as written.
     */
    text: string;
    /**
     * The normalized `http:` or `https:` URL to open.
     */
    url: string;
}

/**
 * The same linkify rules that turn a bare URL in an Agent's Markdown reply into a link, so a URL reads as a link in the
 * user's own message exactly when it would in the reply.
 */
const { linkify } = createMarkdownIt({ linkify: true });

/**
 * Finds the `http(s)://` URLs in plain prose such as a user's message. Bare domains (`example.com`) and email addresses
 * stay text, as they do in a reply.
 */
export function proseWebLinks(text: string): ProseWebLink[] {
    const matches = linkify.match(text) ?? [];
    return matches.flatMap((match) =>
        /^https?:\/\//iu.test(match.url)
            ? [{ index: match.index, text: match.raw, url: match.url }]
            : [],
    );
}
