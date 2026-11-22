import type { UsageLimit } from '@caxri/protocol';

import { runExternalCommand } from '../../../executables';

/**
 * Antigravity's own quota answer: `agy -p /usage --output-format json` runs the built-in `/usage` command without a
 * model turn (its answer reports `num_turns: 0` and zero tokens, verified on `agy` 1.5.14), so reading it spends no
 * quota. It needs no credential from Caxri: the CLI signs in with its own stored login, and a signed-out CLI answers
 * `status: ERROR` with an authentication error instead of waiting, because the command runs without a stdin to paste a
 * code into.
 *
 * The answer groups models that share a quota ("Gemini Models", "Claude and GPT models"), each with buckets named by
 * their window (`5h`, `weekly`, `monthly`) and the fraction still left.
 */
export const ANTIGRAVITY_USAGE_ARGUMENTS = ['-p', '/usage', '--output-format', 'json'] as const;

const USAGE_TIMEOUT_MS = 20_000;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Window lengths by the name `/usage` gives a bucket's `window`, and the plan scope each one is.
 */
const WINDOWS: Readonly<
    Partial<Record<string, { minutes: number; scope?: 'session' | 'weekly' }>>
> = {
    '5h': { minutes: 300, scope: 'session' },
    'weekly': { minutes: 10_080, scope: 'weekly' },
    'monthly': { minutes: 43_200 },
};

/**
 * The usage contract keeps at most four windows per provider: two model groups with a 5-hour and a weekly window each.
 */
const MAX_WINDOWS = 4;

export type AntigravityUsageAnswer =
    | { status: 'signedIn'; limit: Omit<UsageLimit, 'provider'> }
    | { status: 'signedOut' }
    | { status: 'unknown' };

/**
 * A model group's short name as the Chat shows it: `Gemini Models` reads `Gemini`, `Claude and GPT models` reads
 * `Claude & GPT`.
 */
export function antigravityGroupLabel(name: string): string {
    return name
        .trim()
        .replace(/\s+models$/iu, '')
        .replaceAll(/\s+and\s+/giu, ' & ')
        .slice(0, 80);
}

function readWindows(groups: unknown[]): UsageLimit['windows'] {
    const windows: UsageLimit['windows'] = [];
    for (const group of groups) {
        if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
        const groupName = stringField(group.name);
        const label = groupName ? antigravityGroupLabel(groupName) : undefined;
        for (const bucket of group.buckets) {
            const window = bucketWindow(bucket, label);
            if (window) windows.push(window);
            if (windows.length === MAX_WINDOWS) return windows;
        }
    }
    return windows;
}

/**
 * One quota bucket as a plan window, or `undefined` for a disabled bucket or one with an unknown window or fraction.
 */
function bucketWindow(
    bucket: unknown,
    label: string | undefined,
): UsageLimit['windows'][number] | undefined {
    if (!isRecord(bucket) || bucket.disabled === true) return undefined;
    const window = WINDOWS[stringField(bucket.window)?.trim().toLowerCase() ?? ''];
    const remaining = bucket.remaining_fraction;
    if (!window || typeof remaining !== 'number' || !Number.isFinite(remaining)) return undefined;
    const resetsAt = Date.parse(stringField(bucket.reset_time) ?? '');
    return {
        windowMinutes: window.minutes,
        usedPercent: Math.min(100, Math.max(0, (1 - remaining) * 100)),
        ...(Number.isFinite(resetsAt) && resetsAt > 0 && { resetsAt }),
        ...(window.scope && { scope: window.scope }),
        ...(label && { group: label }),
    };
}

/**
 * Parses what `agy -p /usage --output-format json` printed (untrusted). An answer that is not JSON, or an error other
 * than authentication, is `unknown`.
 */
export function parseAntigravityUsage(stdout: string, now: number): AntigravityUsageAnswer {
    let answer: unknown;
    try {
        answer = JSON.parse(stdout);
    } catch {
        return { status: 'unknown' };
    }
    if (!isRecord(answer)) return { status: 'unknown' };
    if (answer.status !== 'SUCCESS')
        return /authenticat|log ?in|sign ?in/iu.test(stringField(answer.error) ?? '')
            ? { status: 'signedOut' }
            : { status: 'unknown' };
    const command = isRecord(answer.command) ? answer.command : undefined;
    const data = isRecord(command?.data) ? command.data : undefined;
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    return { status: 'signedIn', limit: { observedAt: now, windows: readWindows(groups) } };
}

export interface AntigravityUsageCommandOptions {
    executable: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    run?: typeof runExternalCommand;
}

/**
 * Runs `/usage` once. A command that exits non-zero still printed its JSON answer (a signed-out CLI exits 1), so the
 * failure's stdout is parsed too; a spawn failure or timeout is `unknown`.
 */
export async function readAntigravityUsage(
    options: AntigravityUsageCommandOptions,
): Promise<AntigravityUsageAnswer> {
    const run = options.run ?? runExternalCommand;
    const now = options.now ?? Date.now;
    let stdout: string;
    try {
        ({ stdout } = await run(options.executable, ANTIGRAVITY_USAGE_ARGUMENTS, {
            ...(options.cwd !== undefined && { cwd: options.cwd }),
            ...(options.env && { env: options.env }),
            maxBuffer: 256 * 1024,
            timeout: USAGE_TIMEOUT_MS,
        }));
    } catch (error) {
        const failure = error as { killed?: unknown; stdout?: unknown };
        if (failure.killed === true || typeof failure.stdout !== 'string')
            return { status: 'unknown' };
        stdout = failure.stdout;
    }
    return parseAntigravityUsage(stdout, now());
}
