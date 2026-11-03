/**
 * Field validation for the scripted fake Codex turns (`fake-codex-script.ts`). Every check names the offending field in
 * the error it throws, so a malformed script fails at startup with a usable message. This file is loaded by Node's type
 * stripping, so it uses only erasable TypeScript syntax and `.ts` import specifiers.
 */

export type Json = Record<string, unknown>;

export function reject(where: string, problem: string): never {
    throw new Error(`${where}: ${problem}`);
}

/**
 * An object whose keys are all in `allowed`, so a misspelled optional field fails instead of being ignored.
 */
export function asRecord(value: unknown, where: string, allowed: readonly string[]): Json {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return reject(where, 'expected an object');
    const record = value as Json;
    for (const key of Object.keys(record))
        if (!allowed.includes(key))
            reject(where, `unknown field "${key}" (allowed: ${allowed.join(', ')})`);
    return record;
}

export function asArray(value: unknown, where: string): unknown[] {
    if (!Array.isArray(value) || value.length === 0)
        return reject(where, 'expected a non-empty array');
    return value as unknown[];
}

export function asString(value: unknown, where: string, isEmptyAllowed = false): string {
    if (typeof value !== 'string' || (!isEmptyAllowed && value.trim() === ''))
        return reject(where, isEmptyAllowed ? 'expected a string' : 'expected a non-empty string');
    return value;
}

export function asOneOf<Value extends string>(
    value: unknown,
    where: string,
    options: readonly Value[],
): Value {
    if (typeof value === 'string' && (options as readonly string[]).includes(value))
        return value as Value;
    return reject(where, `expected one of ${options.join(', ')}`);
}

export function asOptionalNumber(
    value: unknown,
    where: string,
    isInteger: boolean,
): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        return reject(where, 'expected a non-negative number');
    if (isInteger && !Number.isSafeInteger(value)) return reject(where, 'expected an integer');
    return value;
}

/**
 * An optional boolean flag.
 */
export function asOptionalBoolean(value: unknown, where: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') return reject(where, 'expected a boolean');
    return value;
}
