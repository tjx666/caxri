/**
 * Settings stores Agent launch arguments as argv tokens. The Initial arguments field is written like a command line, so
 * a flag and its value may share a line (`--sandbox workspace`) instead of occupying two rows.
 */

function quoteIfNeeded(token: string): string {
    if (!/[\s"']/.test(token)) return token;
    return `"${token.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`)}"`;
}

/**
 * Split a command-line fragment into argv tokens. Newlines and spaces are equivalent separators; matching single or
 * double quotes keep a value that contains whitespace as one token.
 */
export function parseLaunchArguments(source: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | undefined;
    const flush = (): void => {
        if (current.length === 0) return;
        tokens.push(current);
        current = '';
    };
    for (const character of source) {
        if (quote) {
            if (character === quote) quote = undefined;
            else current += character;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (/\s/.test(character)) {
            flush();
            continue;
        }
        current += character;
    }
    flush();
    return tokens;
}

/**
 * Flatten persisted tokens that were saved as a whole command-line fragment (`--sandbox workspace` as one array entry)
 * into real argv. Only a flag-looking token is re-parsed, so a quoted value already stored as `opus 4` stays one token.
 * Tokens without whitespace stay unchanged, including `--sandbox=workspace`.
 */
export function expandLaunchArguments(arguments_: readonly string[]): string[] {
    return arguments_.flatMap((argument) => {
        if (argument.length === 0) return [];
        return argument.startsWith('-') && /\s/.test(argument)
            ? parseLaunchArguments(argument)
            : [argument];
    });
}

/**
 * Reconstruct the Settings field from argv. Combined persisted fragments are expanded first so `--sandbox workspace`
 * displays as a flag and value on one line rather than a quoted blob. A flag and the following value that does not
 * itself look like a flag share a line.
 */
export function formatLaunchArguments(arguments_: readonly string[]): string {
    const tokens = expandLaunchArguments(arguments_);
    const lines: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        const next = tokens.at(index + 1);
        if (next !== undefined && token.startsWith('-') && !next.startsWith('-')) {
            lines.push(`${token} ${quoteIfNeeded(next)}`);
            index += 1;
            continue;
        }
        lines.push(quoteIfNeeded(token));
    }
    return lines.join('\n');
}
