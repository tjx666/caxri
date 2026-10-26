import { PROFILE_MISSING_MESSAGE, SERVER_NOT_RUNNING_MESSAGE } from '@caxri/client/supervise';
import type { AgentEndpointRef, CaxriErrorCode, WireError } from '@caxri/protocol';
import {
    agentEndpointRefSchema,
    CaxriError,
    isCaxriError,
    PATH_OUTSIDE_PROJECTS_MESSAGE,
    SESSION_SELECTION_REQUIRED_MESSAGE,
} from '@caxri/protocol';
import type { z } from 'zod';

import type { CliAutomation, ResolvedProfile } from './environment';

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
 * Whether every variant of a method's result schema yields a stable ID for `--quiet` (a string, or an Agent Endpoint
 * ref), read from `idKey` on each entry (the result itself, or the list under `quietKey`). A union result, such as a
 * query's per-principal views, must yield one from every variant.
 */
export function hasQuietIds(result: z.ZodType, quietKey?: string, idKey = 'id'): boolean {
    if (result.def.type === 'union')
        return (result as z.ZodUnion<z.ZodType[]>).options.every((option) =>
            hasQuietIds(option, quietKey, idKey),
        );
    const entries = quietKey ? shapeOf(result)[quietKey] : result;
    const entry =
        entries?.def.type === 'array' ? (entries as z.ZodArray<z.ZodType>).element : entries;
    const id = entry === undefined ? undefined : shapeOf(entry)[idKey];
    return id?.def.type === 'string' || id === agentEndpointRefSchema;
}

/**
 * An Agent Endpoint's stable ID: the `<host-id>:<endpoint-id>:<generation>` reference every `agent` command accepts.
 * The protocol's identifier schema would allow a colon, but the Server mints the host ID as a 32-digit hex process
 * identity and the endpoint ID as a UUID, so the joined form always parses back.
 */
export function formatEndpointReference(reference: AgentEndpointRef): string {
    return `${reference.hostId}:${reference.endpointId}:${reference.generation}`;
}

/**
 * One stable ID per entry, read from `idKey`: `id` for most results, or the field a command names in `quietIdKey`. An
 * Agent Endpoint's `ref` prints as its formatted reference, so `agent list --quiet` feeds straight into other `agent`
 * commands.
 */
export function quietLines(value: unknown, idKey = 'id'): string[] {
    const entries: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
    return entries.map((entry) => {
        const id: unknown =
            typeof entry === 'object' && entry !== null ? Reflect.get(entry, idKey) : undefined;
        if (typeof id === 'string' && id.length > 0) return id;
        const endpoint = agentEndpointRefSchema.safeParse(id);
        if (endpoint.success) return formatEndpointReference(endpoint.data);
        throw new CaxriError('VALIDATION', 'Quiet output has no stable ID');
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
    USAGE_LIMITED: 8,
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

/**
 * Whether a mutation may run without `--profile`. The explicit selector exists so a script or Agent can never change
 * the wrong profile by accident. A person typing in a terminal against the single default profile has no other profile
 * to confuse it with, so they may omit it; everything else (CI, Agent callers, piped streams, an inherited
 * `CAXRI_USER_DATA_DIR`) keeps the strict rule.
 */
export function isProfileSelectionSatisfied(input: {
    automation: CliAutomation;
    io: { stdinIsTTY: boolean; stdoutIsTTY: boolean };
    profileFlag: string | undefined;
    profileSource: ResolvedProfile['source'];
}): boolean {
    if (input.profileFlag) return true;
    return (
        input.automation === 'human' &&
        input.io.stdinIsTTY &&
        input.io.stdoutIsTTY &&
        input.profileSource === 'default'
    );
}

/**
 * The exact command to copy when `--profile` is required: the original arguments plus the resolved profile path.
 */
export function profileCommandHint(argv: readonly string[], profilePath: string): string {
    const quote = (value: string): string =>
        /^[\w./:@=+-]+$/u.test(value)
            ? value
            : `"${value.replaceAll(/["$\\`]/gu, String.raw`\$&`)}"`;
    return ['caxri', ...argv.map(quote), '--profile', quote(profilePath)].join(' ');
}

/**
 * Adds the next step to the two connection failures a first-time user meets, without changing the error code. The
 * client keeps its short technical messages; this layer speaks to the person at the terminal.
 */
export function withNextStep(error: WireError): WireError {
    if (error.code === 'PATH_DENIED' && error.message.startsWith(PATH_OUTSIDE_PROJECTS_MESSAGE))
        return {
            ...error,
            message:
                'This folder is not an added Project. Add it with `caxri project add <path>` (or from the Caxri app), then retry.',
        };
    if (error.code === 'CONFLICT' && error.message.startsWith(SESSION_SELECTION_REQUIRED_MESSAGE))
        return {
            ...error,
            message:
                'This Project has no single Session to use. Pass --session <id>; list them with `caxri session list`.',
        };
    if (error.code !== 'NOT_FOUND') return error;
    if (error.message.startsWith(SERVER_NOT_RUNNING_MESSAGE))
        return {
            ...error,
            message:
                "Caxri isn't running. Open the Caxri app, or run `caxri desktop focus --launch`.",
        };
    if (error.message.startsWith(PROFILE_MISSING_MESSAGE))
        return {
            ...error,
            message:
                'The selected Caxri profile folder does not exist. Caxri creates it the first time the app starts: open the Caxri app once, or check the path given to --profile or CAXRI_USER_DATA_DIR.',
        };
    return error;
}
