/**
 * A shell variable assigned on its own line holds only a literal path or word (`R=docs/references`); a value that would
 * need quoting or expansion of its own is not read.
 */
const LITERAL_VALUE = /^[^\s$`'"\\(){}<>;&|*?[\]]*$/u;
const ASSIGNMENT = /^([A-Za-z_]\w*)=(.*)$/su;

/**
 * Reads a command made only of variable assignments (`R=docs/references`) into `variables`. Returns `false` when the
 * words are not all assignments, and `null` when a value is not a literal, which leaves the command unreadable.
 */
export function readAssignments(
    words: readonly string[],
    variables: Map<string, string>,
): boolean | null {
    const assignments = words.map((word) => ASSIGNMENT.exec(word));
    if (assignments.some((match) => !match)) return false;
    for (const match of assignments) {
        const [, name = '', value = ''] = match ?? [];
        if (!LITERAL_VALUE.test(value)) return null;
        variables.set(name, value);
    }
    return true;
}

/**
 * Replaces `$NAME` and `${NAME}` for variables assigned earlier in the same command, outside single quotes, so `sed -n
 * 1,40p $R/a.md` reads `a.md`. Any other variable stays and makes the stage unreadable to `splitWords`.
 */
export function expandVariables(stage: string, variables: ReadonlyMap<string, string>): string {
    if (variables.size === 0) return stage;
    let result = '';
    let quote: '"' | "'" | undefined;
    for (let index = 0; index < stage.length; index += 1) {
        const char = stage[index] ?? '';
        if (quote === "'") {
            if (char === "'") quote = undefined;
            result += char;
            continue;
        }
        if (char === "'" && !quote) quote = "'";
        else if (char === '"') quote = quote ? undefined : '"';
        else if (char === '$') {
            const rest = stage.slice(index);
            const match = /^\$\{([A-Za-z_]\w*)\}/u.exec(rest) ?? /^\$([A-Za-z_]\w*)/u.exec(rest);
            const value = match ? variables.get(match[1]) : undefined;
            if (match && value !== undefined) {
                result += value;
                index += match[0].length - 1;
                continue;
            }
        }
        result += char;
    }
    return result;
}
