/**
 * Punctuation GitHub strips from heading anchors; everything else (including CJK) survives.
 */
const PUNCTUATION = /["#$%&'()*+,./:;<=>?@[\\\]^`{|}~!]/gu;

/**
 * Builds a GitHub-style heading anchor, appending `-1`, `-2`, … when a document repeats a heading.
 *
 * `seen` is per-document state, so two documents rendered from the same engine cannot collide.
 */
export function slugify(heading: string, seen: Map<string, number>): string {
    const base =
        heading
            .trim()
            .toLowerCase()
            .replaceAll(PUNCTUATION, '')
            .replaceAll(/\s+/gu, '-')
            .replaceAll(/-{2,}/gu, '-') || 'section';
    const used = seen.get(base) ?? 0;
    seen.set(base, used + 1);
    return used === 0 ? base : `${base}-${used}`;
}
