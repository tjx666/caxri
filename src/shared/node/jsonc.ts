import type { ParseError } from 'jsonc-parser';
import { parse, printParseErrorCode } from 'jsonc-parser';

/**
 * Parses JSONC and throws a `line`/`column`-formatted error on the first parse
 * failure, used by both settings/keybindings and theme configuration files.
 */
export function parseJsonc(source: string): unknown {
    const errors: ParseError[] = [];
    const value: unknown = parse(source, errors, {
        allowTrailingComma: true,
        disallowComments: false,
    });
    if (errors.length > 0) {
        const first = errors[0];
        const before = source.slice(0, first.offset).split('\n');
        throw new Error(
            `${printParseErrorCode(first.error)} at line ${before.length}, column ${(before.at(-1)?.length ?? 0) + 1}`,
        );
    }
    return value;
}
