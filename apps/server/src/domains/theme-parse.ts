import { CaxriError } from '@caxri/protocol';

/**
 * Parses one untrusted theme document and refuses anything that carries no theme data.
 *
 * Both halves are load-bearing. Malformed input makes the format parsers throw native errors (jsonc's `ValueExpected`,
 * xmldom's `missing root element`, or a `TypeError` once `YAML.parse` has returned `null`), which `toWireError`
 * classifies as `INTERNAL` — so an ordinary bad file is logged like a Caxri crash, with a stack, and reaches the user
 * as `Cannot read properties of null (reading 'name')`. A well-formed but empty document throws nothing at all: every
 * color lookup falls back and the import silently replaces the user's theme with a renamed Dracula clone. Closing one
 * half leaves the other open (issue #750).
 *
 * The underlying parser's message is deliberately not echoed: it can quote the offending line of the user's file, and
 * this message travels into the Server log as well as the toast.
 */
export function parseThemeDocument(
    source: string,
    format: string,
    parse: (text: string) => unknown,
): Record<string, unknown> {
    let value: unknown;
    try {
        value = parse(source);
    } catch {
        throw new CaxriError('VALIDATION', `${format} theme file could not be parsed`);
    }
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length === 0
    )
        throw new CaxriError('VALIDATION', `${format} theme file is empty or has no theme data`);
    return value as Record<string, unknown>;
}
