/**
 * POSIX path resolution for links written inside a Markdown document.
 *
 * Deliberately hand-rolled instead of importing `node:path`: this package is the one rendering pipeline shared by the
 * Renderer, by a future React Native WebView client, and by tests, so it must not reach for a Node built-in.
 */

const SEPARATOR = '/';
/**
 * Matches an absolute URL scheme (`https:`, `mailto:`, `data:`) but not a Windows-looking drive letter.
 */
const URL_SCHEME = /^[a-z][\d+.a-z-]+:/i;

export function isExternalTarget(target: string): boolean {
    return URL_SCHEME.test(target);
}

export function isInPageTarget(target: string): boolean {
    return target.startsWith('#');
}

function directoryOf(path: string): string {
    const separator = path.lastIndexOf(SEPARATOR);
    return separator <= 0 ? SEPARATOR : path.slice(0, separator);
}

function normalizeSegments(path: string): string {
    const resolved: string[] = [];
    for (const segment of path.split(SEPARATOR)) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            resolved.pop();
            continue;
        }
        resolved.push(segment);
    }
    return SEPARATOR + resolved.join(SEPARATOR);
}

/**
 * True when `path` is `root` itself or sits underneath it. The trailing separator matters: without it `/a/bc` would
 * count as living inside `/a/b`.
 */
function isInside(root: string, path: string): boolean {
    if (path === root) return true;
    const prefix = root.endsWith(SEPARATOR) ? root : root + SEPARATOR;
    return path.startsWith(prefix);
}

export interface DocumentLocation {
    /**
     * Absolute POSIX path of the document being rendered.
     */
    documentPath: string;
    /**
     * Absolute POSIX path of the Project root that authorizes the document.
     */
    projectRoot: string;
}

/**
 * Resolves one relative or root-relative link target to an absolute path inside the Project root.
 *
 * Returns `undefined` for external URLs, empty targets, and anything that escapes the root. The Server re-authorizes
 * every read, so this is defense in depth rather than the only gate, but resolving an escaping path here would put a
 * path the user cannot open into the rendered document.
 */
export function resolveDocumentTarget(
    target: string,
    { documentPath, projectRoot }: DocumentLocation,
): string | undefined {
    if (!target || isExternalTarget(target) || isInPageTarget(target)) return undefined;
    const withoutFragment = target.split('#', 1)[0]?.split('?', 1)[0] ?? '';
    if (!withoutFragment) return undefined;
    let decoded: string;
    try {
        decoded = decodeURIComponent(withoutFragment);
    } catch {
        // A malformed escape sequence is a broken link, not a reason to fail the whole document.
        decoded = withoutFragment;
    }
    const base = decoded.startsWith(SEPARATOR) ? projectRoot : directoryOf(documentPath);
    const resolved = normalizeSegments(`${base}${SEPARATOR}${decoded}`);
    return isInside(projectRoot, resolved) ? resolved : undefined;
}
