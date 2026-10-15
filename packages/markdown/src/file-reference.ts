/**
 * Extensions a bare file name (no directory, no line suffix) must carry before inline code reads as a file. Without a
 * directory or a location, `console.log` and `user.name` look exactly like file names, so only common source, config,
 * and document extensions qualify.
 */
const BARE_FILE_EXTENSIONS = new Set([
    'c',
    'cc',
    'cjs',
    'cpp',
    'cs',
    'css',
    'cts',
    'go',
    'h',
    'hpp',
    'html',
    'java',
    'js',
    'json',
    'jsonc',
    'jsx',
    'kt',
    'less',
    'lock',
    'lua',
    'md',
    'mdx',
    'mjs',
    'mts',
    'php',
    'py',
    'rb',
    'rs',
    'scss',
    'sh',
    'sql',
    'svelte',
    'swift',
    'toml',
    'ts',
    'tsx',
    'txt',
    'vue',
    'xml',
    'yaml',
    'yml',
    'zsh',
]);

/**
 * A relative or absolute path whose last segment has an extension, optionally followed by a `:line[:column]` or
 * GitHub-style `#Lstart[-Lend]` location. Spaces are excluded: inline code with a space is a command or prose, not a
 * path an Agent cites.
 */
const FILE_REFERENCE =
    /^(?<path>(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w.@+-]*\w\.(?<extension>[A-Za-z][\w-]{0,15}))(?<location>:\d+(?::\d+|-\d+)?|#L\d+(?:-L?\d+)?)?$/u;

/**
 * A relative path whose first segment reads as a host name (`example.com/a.html`) is a URL without its scheme.
 */
const HOST_SEGMENT = /^[\w-]+(?:\.[\w-]+)*\.(?:ai|app|cn|co|com|dev|io|net|org|sh)$/iu;

/**
 * A model or package version (`glm-5.3`, `qwen2.5`) has a digit-dot-digit run where a file name has its extension.
 */
const VERSION_BASENAME = /\d\.\d[^.]*$/u;

/**
 * Reads a path-like reference out of an inline code span or a link destination. Returns the reference as written (path
 * plus location suffix) so the host's own link resolver parses the location, or `undefined` for anything that is not
 * plausibly a file: URLs, commands, identifiers, and bare names with an uncommon extension.
 */
export function fileReferenceTarget(value: string): string | undefined {
    const text = value.trim();
    if (text.length === 0 || text.length > 1024 || text.includes('://')) return undefined;
    const match = FILE_REFERENCE.exec(text);
    if (!match?.groups) return undefined;
    const { path = '', extension = '', location = '' } = match.groups;
    const segments = path.split('/');
    const basename = segments.at(-1) ?? '';
    if (VERSION_BASENAME.test(basename)) return undefined;
    const isRelative = !/^(?:~\/|\.{1,2}\/|\/)/u.test(path);
    if (isRelative && segments.length > 1 && HOST_SEGMENT.test(segments[0] ?? '')) return undefined;
    /**
     * A bare name needs a common extension, or a location suffix on something that is not a host (`example.com:443`).
     */
    if (
        segments.length === 1 &&
        !BARE_FILE_EXTENSIONS.has(extension.toLowerCase()) &&
        (!location || HOST_SEGMENT.test(basename))
    )
        return undefined;
    /**
     * `a.ts:10-20` is how Agents cite a range; the host's resolver reads ranges in GitHub's `#L10-L20` form.
     */
    const range = /^:(\d+)-(\d+)$/u.exec(location);
    return range ? `${path}#L${range[1]}-L${range[2]}` : text;
}

/**
 * Turns a Markdown link destination into a local file target. Agents cite files as `[a.ts](/abs/a.ts:12)`,
 * `[a.ts](src/a.ts#L12)`, or `file:///abs/a.ts`; markdown-it has already percent-encoded the destination, so it is
 * decoded back to the path the Agent wrote. A destination with any other scheme, or an in-page anchor, is not a file.
 */
export function fileLinkTarget(destination: string): string | undefined {
    let value = destination;
    if (/^file:\/\//iu.test(value)) value = value.replace(/^file:\/\/(?:localhost)?/iu, '');
    else if (/^[a-z][\d+.a-z-]*:/iu.test(value) || value.startsWith('#')) return undefined;
    try {
        value = decodeURI(value);
    } catch {
        return undefined;
    }
    return value.length > 0 && value.length <= 1024 && !/[\n\r]/u.test(value) ? value : undefined;
}

/**
 * A path-shaped run inside prose. `\w` is ASCII-only, so a path written flush against CJK text (`修改了 src/a.ts，`) still
 * starts and ends at the path. {@link fileReferenceTarget} still decides whether a run is a file.
 */
const PROSE_PATH =
    /(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w.@+-]*\w\.[A-Za-z][\w-]{0,15}(?::\d+(?::\d+|-\d+)?|#L\d+(?:-L?\d+)?)?/gu;

/**
 * Quoted rooted paths may contain spaces, such as an application data directory.
 */
const QUOTED_PROSE_PATH = /(["'])(?<path>(?:~\/|\.{1,2}\/|\/)[^"'\r\n<>]+)\1/gu;

/**
 * Characters that, next to a run, mean it is a fragment of a longer token: a URL (`https://a.dev/x.ts`), an email, or a
 * dotted identifier. A trailing `.` is allowed only when nothing word-like follows it, so a sentence may end on a
 * path.
 */
const INNER_BEFORE = /[\w./@+:~-]/u;
const INNER_AFTER = /^(?:[\w/@+-]|\.\w|:\/)/u;

/**
 * One file reference found in prose, as {@link fileReferenceTarget} reads it.
 */
export interface ProseFileReference {
    /**
     * Offset of the reference in the scanned text.
     */
    index: number;
    /**
     * The reference exactly as written.
     */
    text: string;
    /**
     * The target to open, with a `:10-20` range rewritten to `#L10-L20`.
     */
    file: string;
}

/**
 * Finds file references in plain prose such as `see src/app.ts:12` or `/repo/a.md`. Prose is stricter than inline code:
 * a run needs a directory or a location suffix, because `Node.js` and `index.ts` written as words are names, not
 * citations.
 */
export function proseFileReferences(text: string): ProseFileReference[] {
    const references: ProseFileReference[] = [];
    for (const match of text.matchAll(QUOTED_PROSE_PATH)) {
        const value = match.groups?.path;
        if (!value || !fileReferenceTarget(value.replaceAll(' ', '_'))) continue;
        const file = fileLinkTarget(value)?.replace(/:(\d+)-(\d+)$/u, '#L$1-L$2');
        if (file) references.push({ index: match.index + 1, text: value, file });
    }
    for (const match of text.matchAll(PROSE_PATH)) {
        const value = match[0];
        const index = match.index;
        if (
            references.some(
                (reference) =>
                    index >= reference.index && index < reference.index + reference.text.length,
            )
        )
            continue;
        if (index > 0 && INNER_BEFORE.test(text[index - 1] ?? '')) continue;
        if (INNER_AFTER.test(text.slice(index + value.length))) continue;
        if (!value.includes('/') && !/[:#]/u.test(value)) continue;
        const file = fileReferenceTarget(value);
        if (file) references.push({ index, text: value, file });
    }
    return references.toSorted((left, right) => left.index - right.index);
}
