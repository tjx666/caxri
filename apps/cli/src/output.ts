import type { CaxriErrorCode, WireError } from '@caxri/protocol';
import { CaxriError, isCaxriError } from '@caxri/protocol';
import type { z } from 'zod';

export type CliOutputMode = 'human' | 'json' | 'quiet';

function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, sorted(entry)]),
    );
}

export function stableJson(value: unknown): string {
    return JSON.stringify(sorted(value));
}

/**
 * A result or entry field may be missing, which is exactly what `hasQuietIds` looks for.
 */
function shapeOf(schema: z.ZodType): Partial<Record<string, z.ZodType>> {
    return schema.def.type === 'object'
        ? (schema as z.ZodObject<Record<string, z.ZodType>>).shape
        : {};
}

/**
 * Whether every variant of a method's result schema yields a string ID for `--quiet`, read from `idKey` on each entry
 * (the result itself, or the list under `quietKey`). A union result, such as a query's per-principal views, must yield
 * one from every variant.
 */
export function hasQuietIds(result: z.ZodType, quietKey?: string, idKey = 'id'): boolean {
    if (result.def.type === 'union')
        return (result as z.ZodUnion<z.ZodType[]>).options.every((option) =>
            hasQuietIds(option, quietKey, idKey),
        );
    const entries = quietKey ? shapeOf(result)[quietKey] : result;
    const entry =
        entries?.def.type === 'array' ? (entries as z.ZodArray<z.ZodType>).element : entries;
    return entry !== undefined && shapeOf(entry)[idKey]?.def.type === 'string';
}

/**
 * One stable ID per entry, read from `idKey`: `id` for most results, or the field a command names in `quietIdKey`.
 */
export function quietLines(value: unknown, idKey = 'id'): string[] {
    const entries: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
    return entries.map((entry) => {
        const id: unknown =
            typeof entry === 'object' && entry !== null ? Reflect.get(entry, idKey) : undefined;
        if (typeof id !== 'string' || id.length === 0)
            throw new CaxriError('VALIDATION', 'Quiet output has no stable ID');
        return id;
    });
}

const exitCodes: Record<CaxriErrorCode, number> = {
    VALIDATION: 2,
    NOT_FOUND: 3,
    CANCELLED: 4,
    CONFLICT: 4,
    PATH_DENIED: 5,
    FORBIDDEN: 5,
    UNAVAILABLE: 6,
    TIMEOUT: 7,
    CAPACITY: 8,
    IO: 9,
    GIT: 9,
    INTERNAL: 10,
};

function redactString(value: string, home: string | undefined): string {
    let redacted = home ? value.replaceAll(home, '$HOME') : value;
    redacted = redacted.replaceAll(/\b[0-9a-f]{48,}\b/giu, '[redacted]');
    redacted = redacted.replaceAll(
        /\b(?:token|secret|password|credential)=\S+/giu,
        (match) => `${match.split('=', 1)[0]}=[redacted]`,
    );
    return redacted;
}

function redactDetails(value: unknown, home: string | undefined): unknown {
    if (typeof value === 'string') return redactString(value, home);
    if (Array.isArray(value)) return value.slice(0, 32).map((entry) => redactDetails(entry, home));
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => !/token|secret|password|credential/iu.test(key))
            .slice(0, 32)
            .map(([key, entry]) => [key, redactDetails(entry, home)]),
    );
}

export function normalizeCliError(error: unknown, home?: string): WireError {
    if (!isCaxriError(error)) return { code: 'INTERNAL', message: 'Internal Caxri CLI error' };
    if (error.code === 'INTERNAL') return { code: 'INTERNAL', message: 'Internal Caxri CLI error' };
    const details = error.details
        ? (redactDetails(error.details, home) as Record<string, unknown>)
        : undefined;
    const message = redactString(error.message, home);
    return details ? { code: error.code, message, details } : { code: error.code, message };
}

export function exitCodeFor(error: WireError): number {
    return exitCodes[error.code];
}

export function renderHumanValue(value: unknown): string {
    if (value === null || value === undefined) return 'OK';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
        return String(value);
    if (typeof value !== 'object') return stableJson(value);
    if (Array.isArray(value)) return value.map((entry) => stableJson(entry)).join('\n');
    return Object.entries(value)
        .map(([key, entry]) => `${key}: ${renderHumanValue(entry)}`)
        .join('\n');
}
