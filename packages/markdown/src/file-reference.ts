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
 * The path part shared by inline code and prose, as two alternatives.
 *
 * 1. A rooted (`/` or `~/`) path with at least one directory above its last segment, which may have no extension:
 *    `/repo/.local-config`, `~/x/.env`, `/repo/Makefile`. It is how an absolute path to a directory or a dotfile reads.
 *    Rooted-only keeps `apps/desktop` and `user.name` out, and the directory requirement keeps a one-word slash command
 *    (`/model`, `/btw`) out. The last character must be a word character so a sentence-ending `.` stays outside the
 *    path (`see /repo/dir.`). It goes first so a dotted directory (`/repo/my.app/sub`) is not cut short by the second
 *    alternative.
 * 2. Any other relative or absolute path whose last segment has an extension (`src/a.ts`, `./a.md`, `/a.ts`).
 */
const PATH_SOURCE =
    String.raw`(?:~\/|\/)(?:[\w.@+-]+\/)+[\w.@+-]*\w` +
    String.raw`|(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w.@+-]*\w\.(?<extension>[A-Za-z][\w-]{0,15})`;

/**
 * A path from {@link PATH_SOURCE}, optionally followed by a `:line[:column]` or GitHub-style `#Lstart[-Lend]` location.
 * Spaces are excluded: inline code with a space is a command or prose, not a path an Agent cites.
 */
const FILE_REFERENCE = new RegExp(
    String.raw`^(?<path>${PATH_SOURCE})(?<location>:\d+(?::\d+|-\d+)?|#L\d+(?:-L?\d+)?)?$`,
    'u',
);

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
const PROSE_PATH = new RegExp(
    String.raw`(?:${PATH_SOURCE.replace('(?<extension>', '(')})(?::\d+(?::\d+|-\d+)?|#L\d+(?:-L?\d+)?)?`,
    'gu',
);

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
    const references = quotedPathReferences(text);
    const isQuoted = (index: number) =>
        references.some(
            (quoted) => index >= quoted.index && index < quoted.index + quoted.text.length,
        );
    for (const match of text.matchAll(PROSE_PATH)) {
        const value = match[0];
        const index = match.index;
        if (isQuoted(index)) continue;
        if (index > 0 && INNER_BEFORE.test(text[index - 1] ?? '')) continue;
        if (INNER_AFTER.test(text.slice(index + value.length))) continue;
        if (!value.includes('/') && !/[:#]/u.test(value)) continue;
        const file = fileReferenceTarget(value);
        if (file) references.push({ index, text: value, file });
    }
    // `references` is this call's own array, and the phone's ES2022 runtime has no `toSorted`.
    // eslint-disable-next-line unicorn/no-array-sort -- sorting a local array in place
    return references.sort((a, b) => a.index - b.index);
}

/**
 * A rooted path in quotes, which may hold spaces: `"/Users/me/Library/Application Support/x.md"`. A space ends a path
 * everywhere else, but a quoted absolute, home, or `./` path is how a shell-safe pointer (a delegated task's) or a
 * pasted Finder path spells one, and stopping at its first space links only the tail.
 */
const QUOTED_PATH = /(["'`])((?:~\/|\.{1,2}\/|\/)[^"'`\n]*)\1/gu;

function quotedPathReferences(text: string): ProseFileReference[] {
    const references: ProseFileReference[] = [];
    for (const match of text.matchAll(QUOTED_PATH)) {
        const value = match[2] ?? '';
        // A path without a space is the ordinary scan's.
        if (!value.includes(' ')) continue;
        // Quoted prose such as "/ and /" must not read as a path, so the extensionless form stays unquoted-only.
        if (!/\w\.[A-Za-z]/u.test(value.split('/').at(-1) ?? '')) continue;
        // Spaces are what the quotes allow; the rest of the path still has to read as a file. The stand-in keeps every
        // offset, so the spaces go back where they were in the target (whose `:10-20` may have become `#L10-L20`).
        const target = fileReferenceTarget(value.replaceAll(' ', '_'));
        if (!target) continue;
        const file = [...target].map((char, at) => (value[at] === ' ' ? ' ' : char)).join('');
        references.push({ index: match.index + 1, text: value, file });
    }
    return references;
}
