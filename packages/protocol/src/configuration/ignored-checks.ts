export const MAX_IGNORED_CHECKS = 64;
export const MAX_IGNORED_CHECK_LENGTH = 256;

/**
 * Canonicalizes one persisted `projectStatus.ignoredChecks` rule. A rule is a literal check name or a `*`/`?` glob, so
 * normalization only trims surrounding whitespace and rejects an empty or oversized entry; the pattern itself stays
 * exactly as the user wrote it, because GitHub job names legitimately contain spaces, slashes, and parentheses.
 */
export function normalizeIgnoredCheckRule(input: string): string | undefined {
    const value = input.trim();
    if (!value || value.length > MAX_IGNORED_CHECK_LENGTH || value.includes('\0')) return;
    return value;
}

const compiledPatterns = new Map<string, RegExp>();

function escapeRegex(character: string): string {
    return /[\\^$+.()|{}[\]]/.test(character) ? `\\${character}` : character;
}

/**
 * Compiles a rule into an anchored, case-insensitive matcher supporting `*` (any run of characters) and `?` (exactly
 * one). Check names are flat labels rather than paths, so, unlike `files.exclude`, no separator is significant and `**`
 * carries no extra meaning.
 */
function compilePattern(pattern: string): RegExp {
    const cached = compiledPatterns.get(pattern);
    if (cached) return cached;
    let source = '';
    for (const character of pattern) {
        if (character === '*') source += '.*';
        else if (character === '?') source += '.';
        else source += escapeRegex(character);
    }
    const compiled = new RegExp(`^${source}$`, 'iu');
    // The rule list is capped at MAX_IGNORED_CHECKS, but a user editing settings.jsonc churns through drafts; clearing
    // wholesale keeps this process-lifetime cache bounded without tracking per-entry age.
    if (compiledPatterns.size >= MAX_IGNORED_CHECKS * 4) compiledPatterns.clear();
    compiledPatterns.set(pattern, compiled);
    return compiled;
}

/**
 * Whether any of a check's identifying labels matches an ignore rule. Callers pass the job name, the status context,
 * and the workflow name, so a single rule naming a workflow suppresses every job that workflow produces. Matching is
 * case-insensitive: a rule is typed by hand from a CI dashboard, and a capitalization slip should not silently stop
 * suppressing the job the user meant.
 */
export function isIgnoredCheck(
    labels: ReadonlyArray<string | undefined>,
    rules: readonly string[],
): boolean {
    if (rules.length === 0) return false;
    for (const rule of rules.slice(0, MAX_IGNORED_CHECKS)) {
        const pattern = normalizeIgnoredCheckRule(rule);
        if (!pattern) continue;
        const compiled = compilePattern(pattern);
        for (const label of labels) if (label && compiled.test(label)) return true;
    }
    return false;
}
