import { linkSummary } from '../../lib/link-summary';

/**
 * A short mention in prose (`#2354`, `ENG-123`) mapped to the one link it stands for, so a reply that refers back to a
 * pull request or issue by number reads as that link.
 */
export type ReferenceMentionIndex = ReadonlyMap<string, string>;

/**
 * One run of a text node: plain text, or a mention the index resolves.
 */
export type ReferenceMentionSegment =
    { kind: 'text'; text: string } | { kind: 'mention'; text: string; href: string };

/**
 * `#123` not glued to a word, an HTML entity (`&#123;`), a path or URL fragment (`/#123`), or another `#`; and an
 * uppercase Linear-style identifier (`ENG-123`) not inside a longer token. ASCII-only boundaries, so a mention right
 * after a CJK character, with no space as Chinese prose writes it, still matches.
 */
const MENTION_PATTERN =
    /(?<![\w&/#])#\d{1,9}(?![\w-])|(?<![\w/.-])[A-Z][\dA-Z]{0,15}-\d{1,9}(?![\w-])/gu;

/**
 * Indexes the numbered GitHub pull requests and issues and the Linear issues among `urls`, keyed by how prose mentions
 * them: `#<number>` and the Linear identifier. A key two different targets share (`#12` in two repositories, or an
 * identifier in two workspaces) is left out, since the mention alone cannot say which one it means. A pull request and
 * an issue link with the same number in one repository are the same GitHub number, so the first link seen is kept.
 */
export function referenceMentionIndex(urls: Iterable<string>): ReferenceMentionIndex {
    const targets = new Map<string, 'ambiguous' | { href: string; owner: string }>();
    const add = (key: string, owner: string, href: string) => {
        const previous = targets.get(key);
        if (previous === undefined) targets.set(key, { href, owner });
        else if (previous !== 'ambiguous' && previous.owner !== owner)
            targets.set(key, 'ambiguous');
    };
    for (const url of urls) {
        const summary = linkSummary(url);
        if (!summary) continue;
        const { linearIssue, reference } = summary;
        if (reference) {
            const section = summary.kind === 'pull' ? 'pull' : 'issues';
            add(
                `#${reference.number}`,
                `${reference.owner}/${reference.repo}`.toLowerCase(),
                `https://github.com/${reference.owner}/${reference.repo}/${section}/${reference.number}`,
            );
        } else if (linearIssue)
            add(
                linearIssue.identifier,
                linearIssue.workspace.toLowerCase(),
                `https://linear.app/${linearIssue.workspace}/issue/${linearIssue.identifier}`,
            );
    }
    const index = new Map<string, string>();
    for (const [key, target] of targets) if (target !== 'ambiguous') index.set(key, target.href);
    return index;
}

/**
 * Whether two indexes map the same mentions to the same links, so a caller can keep the previous one and spare every
 * rendered reply a re-render when a new message added no reference.
 */
export function isSameReferenceMentionIndex(
    a: ReferenceMentionIndex,
    b: ReferenceMentionIndex,
): boolean {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const [key, href] of a) if (b.get(key) !== href) return false;
    return true;
}

/**
 * Splits `text` into plain runs and the mentions `index` resolves, or returns `undefined` when it holds none, so the
 * common case renders the string as is.
 */
export function referenceMentionSegments(
    text: string,
    index: ReferenceMentionIndex,
): ReferenceMentionSegment[] | undefined {
    const segments: ReferenceMentionSegment[] = [];
    let offset = 0;
    for (const match of text.matchAll(MENTION_PATTERN)) {
        const href = index.get(match[0]);
        if (href === undefined) continue;
        if (match.index > offset)
            segments.push({ kind: 'text', text: text.slice(offset, match.index) });
        segments.push({ kind: 'mention', text: match[0], href });
        offset = match.index + match[0].length;
    }
    if (segments.length === 0) return undefined;
    if (offset < text.length) segments.push({ kind: 'text', text: text.slice(offset) });
    return segments;
}
