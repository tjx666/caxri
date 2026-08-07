export type FileTreeExcludes = Readonly<Record<string, boolean>>;

const MAX_COMPILED_PATTERNS = 500;
const compiledPatterns = new Map<string, RegExp>();

function escapeRegex(character: string): string {
    return /[\\^$+?.()|{}[\]]/.test(character) ? `\\${character}` : character;
}

function compilePattern(input: string): RegExp {
    const cached = compiledPatterns.get(input);
    if (cached) return cached;
    let pattern = input.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '');
    if (!pattern.includes('/')) pattern = `**/${pattern}`;
    let source = '';
    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];
        if (character === '*' && pattern[index + 1] === '*') {
            if (pattern[index + 2] === '/') {
                source += '(?:.*/)?';
                index += 2;
            } else {
                source += '.*';
                index += 1;
            }
        } else if (character === '*') source += '[^/]*';
        else if (character === '?') source += '[^/]';
        else source += escapeRegex(character);
    }
    const compiled = new RegExp(`^${source}$`);
    if (compiledPatterns.size >= MAX_COMPILED_PATTERNS) compiledPatterns.clear();
    compiledPatterns.set(input, compiled);
    return compiled;
}

/** Matches a Project-relative path against enabled `files.exclude` glob entries. */
export function matchesFileTreeExclude(relativePath: string, excludes: FileTreeExcludes): boolean {
    const normalizedPath = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
    return Object.entries(excludes).some(
        ([pattern, enabled]) =>
            enabled && pattern.trim() !== '' && compilePattern(pattern).test(normalizedPath),
    );
}
