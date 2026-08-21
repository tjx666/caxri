/**
 * `user@host:` is what a default `zsh`/`bash` prompt hook puts in front of every OSC 0/2 title. On a local Terminal it
 * is the same string for every tab in the window, so it is pure noise that pushes the part that actually identifies the
 * Terminal past the truncation point.
 */
const HOST_PREFIX = /^[^\s:@]+@[^\s:]+:\s*/u;

/**
 * A filesystem path rooted at `/`, `~/`, `./`, or `../`.
 *
 * Compression is gated on this shape rather than on the absence of spaces: a directory name may well contain a space
 * (`~/Code/My Project/src`), while plenty of prose contains a slash (`Fix/verify/now`) and every URL contains several.
 * Requiring an explicit root marker is what separates the two without guessing.
 */
const ROOTED_PATH = /^(?:~|\.{1,2})?\//u;

/**
 * Trailing segments a compressed label keeps after the ellipsis; the root marker (`~`, `.`, or the empty string an
 * absolute path splits into) is always kept in front of it.
 */
const KEPT_TRAILING_SEGMENTS = 1;

/**
 * Shortest path worth compressing. At three segments the ellipsis is no shorter than the segment it replaces, so
 * `~/code/caxri` stays intact rather than becoming a less informative `~/…/caxri`.
 */
const MINIMUM_COMPRESSED_SEGMENTS = 4;

/**
 * Turns a PTY-reported window title into the label a tab shows.
 *
 * Terminal titles are overwhelmingly `user@host: /some/deep/path`, and a tab is far too narrow to render that: plain
 * end-truncation would show every tab as the same host prefix. This keeps the identifying tail — the directory the
 * Terminal is actually in — the way iTerm2 and VS Code both compress a path for a narrow slot. The untouched title
 * stays available as the tab's tooltip and accessible name.
 */
export function terminalTabLabel(title: string): string {
    const withoutHost = title.replace(HOST_PREFIX, '').trim();
    const label = withoutHost || title;
    if (!ROOTED_PATH.test(label)) return label;
    // A shell reports `~/code/caxri/` and `~/code/caxri` for the same directory; the empty tail segment is not a name.
    const segments = label.replace(/\/$/u, '').split('/');
    if (segments.length < MINIMUM_COMPRESSED_SEGMENTS) return label;
    return [segments[0], '…', ...segments.slice(-KEPT_TRAILING_SEGMENTS)].join('/');
}
