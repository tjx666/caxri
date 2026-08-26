import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type { CausalCapsule } from './causal-chain.js';
import { failureReasons, remediationCategories } from './causal-chain.js';
import type { ObservationContext } from './context.js';
import { mergeObservationContext, normalizeObservationContext } from './context.js';
import { observationOwners, observationPhases } from './metrics.js';

export const observationProcessOwners = ['server-core', 'terminal-host', 'extension-host'] as const;
export const observationProcessStates = [
    'starting',
    'ready',
    'stopping',
    'stopped',
    'failed',
] as const;

export type ObservationProcessOwner = (typeof observationProcessOwners)[number];
export type ObservationProcessState = (typeof observationProcessStates)[number];

export interface ObservationProcessManifest {
    context: ObservationContext;
    failure?: CausalCapsule;
    owner: ObservationProcessOwner;
    pid: number;
    schemaVersion: 1;
    startedAt: number;
    state: ObservationProcessState;
    updatedAt: string;
}

export type ObservationProcessManifests = Partial<
    Record<ObservationProcessOwner, ObservationProcessManifest>
>;

export const MAX_OBSERVATION_PROCESS_MANIFEST_BYTES = 32 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
}

function isTimestamp(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function parseObservationContext(value: unknown): ObservationContext | undefined {
    if (!isRecord(value)) return;
    const allowed = [
        'agentRunId',
        'bootId',
        'buildId',
        'clientId',
        'connectionId',
        'operationId',
        'processId',
        'projectId',
        'requestId',
        'serverId',
        'sessionId',
        'terminalId',
        'traceId',
    ] as const;
    if (!hasOnlyKeys(value, allowed)) return;
    const normalized = normalizeObservationContext(value);
    if (
        Object.keys(normalized).length !== Object.keys(value).length ||
        Object.entries(value).some(([key, entry]) =>
            Object.is(normalized[key as keyof ObservationContext], entry) ? false : true,
        )
    )
        return;
    return normalized;
}

function parseCausalCapsule(value: unknown): CausalCapsule | undefined {
    if (!isRecord(value)) return;
    if (
        !hasOnlyKeys(value, [
            'code',
            'context',
            'owner',
            'phase',
            'reason',
            'remediation',
            'retryable',
            'schemaVersion',
            'timestamp',
        ]) ||
        value.schemaVersion !== 1 ||
        !observationOwners.includes(value.owner as never) ||
        !observationPhases.includes(value.phase as never) ||
        !failureReasons.includes(value.reason as never) ||
        !remediationCategories.includes(value.remediation as never) ||
        typeof value.retryable !== 'boolean' ||
        !isTimestamp(value.timestamp) ||
        (value.code !== undefined &&
            (typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.code)))
    )
        return;
    const context = parseObservationContext(value.context);
    if (!context) return;
    return { ...value, context } as CausalCapsule;
}

export function parseObservationProcessManifest(
    value: unknown,
): ObservationProcessManifest | undefined {
    if (
        !isRecord(value) ||
        !hasOnlyKeys(value, [
            'context',
            'failure',
            'owner',
            'pid',
            'schemaVersion',
            'startedAt',
            'state',
            'updatedAt',
        ]) ||
        value.schemaVersion !== 1 ||
        !observationProcessOwners.includes(value.owner as never) ||
        !observationProcessStates.includes(value.state as never) ||
        !Number.isSafeInteger(value.pid) ||
        Number(value.pid) <= 0 ||
        !Number.isSafeInteger(value.startedAt) ||
        Number(value.startedAt) <= 0 ||
        !isTimestamp(value.updatedAt)
    )
        return;
    const context = parseObservationContext(value.context);
    const failure = value.failure === undefined ? undefined : parseCausalCapsule(value.failure);
    if (!context || context.processId !== value.pid) return;
    if (!failure && value.failure !== undefined) return;
    return {
        context,
        ...(failure && { failure }),
        owner: value.owner as ObservationProcessOwner,
        pid: Number(value.pid),
        schemaVersion: 1,
        startedAt: Number(value.startedAt),
        state: value.state as ObservationProcessState,
        updatedAt: value.updatedAt,
    };
}

export function observationProcessManifestDirectory(userDataPath: string): string {
    return join(userDataPath, 'observability', 'processes');
}

export function observationProcessManifestPath(
    directory: string,
    owner: ObservationProcessOwner,
): string {
    return join(directory, `${owner}.json`);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error('Observation process manifest directory must be a real directory');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        throw new Error('Observation process manifest directory belongs to another user');
    await chmod(directory, 0o700);
}

async function writePrivateManifest(
    directory: string,
    path: string,
    value: ObservationProcessManifest,
): Promise<void> {
    await ensurePrivateDirectory(directory);
    const source = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(source, 'utf8') > MAX_OBSERVATION_PROCESS_MANIFEST_BYTES)
        throw new Error('Observation process manifest exceeds its storage bound');
    const temporary = join(directory, `.${value.owner}.${process.pid}.${randomUUID()}.tmp`);
    try {
        const handle = await open(
            temporary,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
        );
        try {
            await handle.writeFile(source, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, path);
        await chmod(path, 0o600);
    } finally {
        await rm(temporary, { force: true });
    }
}

function fileSystemCode(error: unknown): string | undefined {
    return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

export async function readObservationProcessManifest(
    path: string,
): Promise<ObservationProcessManifest> {
    const metadata = await lstat(path);
    if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size > MAX_OBSERVATION_PROCESS_MANIFEST_BYTES
    )
        throw new Error('Observation process manifest must be a bounded private regular file');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        throw new Error('Observation process manifest belongs to another user');
    let value: unknown;
    try {
        value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
        throw new Error('Observation process manifest is malformed');
    }
    const parsed = parseObservationProcessManifest(value);
    if (!parsed) throw new Error('Observation process manifest is invalid');
    return parsed;
}

export async function readObservationProcessManifests(
    directory: string,
): Promise<ObservationProcessManifests> {
    const entries = await Promise.all(
        observationProcessOwners.map(async (owner) => {
            try {
                return [
                    owner,
                    await readObservationProcessManifest(
                        observationProcessManifestPath(directory, owner),
                    ),
                ] as const;
            } catch (error) {
                if (fileSystemCode(error) === 'ENOENT') return;
                throw error;
            }
        }),
    );
    return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}

export interface ObservationProcessManifestPublisherOptions {
    context?: ObservationContext;
    directory: string;
    now?: () => Date;
    owner: ObservationProcessOwner;
    pid?: number;
    startedAt?: number;
}

/**
 * Coalesces lifecycle publications so diagnostics IO never blocks or queues behind product work. Only the latest
 * bounded state is retained while a write is in flight; failures are counted and swallowed for caller inspection.
 */
export class ObservationProcessManifestPublisher {
    private context: ObservationContext;
    private drainPromise?: Promise<void>;
    private readonly now: () => Date;
    private readonly path: string;
    private pending?: ObservationProcessManifest;
    private readonly pid: number;
    private readonly startedAt: number;
    private writeFailures = 0;

    constructor(private readonly options: ObservationProcessManifestPublisherOptions) {
        this.pid = options.pid ?? process.pid;
        this.startedAt = options.startedAt ?? Date.now();
        this.now = options.now ?? (() => new Date());
        this.path = observationProcessManifestPath(options.directory, options.owner);
        this.context = mergeObservationContext(options.context, { processId: this.pid });
    }

    private scheduleDrain(): void {
        this.drainPromise ??= this.runDrain();
    }

    private async runDrain(): Promise<void> {
        try {
            await this.drain();
        } finally {
            this.drainPromise = undefined;
            if (this.pending) this.scheduleDrain();
        }
    }

    private async drain(): Promise<void> {
        while (this.pending) {
            const next = this.pending;
            this.pending = undefined;
            try {
                // eslint-disable-next-line no-await-in-loop -- one latest-value publisher serializes atomic replacements.
                await writePrivateManifest(this.options.directory, this.path, next);
            } catch {
                this.writeFailures += 1;
            }
        }
    }

    publish(
        state: ObservationProcessState,
        options: { context?: ObservationContext; failure?: CausalCapsule } = {},
    ): void {
        this.context = mergeObservationContext(this.context, options.context, {
            processId: this.pid,
        });
        this.pending = {
            context: this.context,
            ...(options.failure && { failure: structuredClone(options.failure) }),
            owner: this.options.owner,
            pid: this.pid,
            schemaVersion: 1,
            startedAt: this.startedAt,
            state,
            updatedAt: this.now().toISOString(),
        };
        this.scheduleDrain();
    }

    failureCount(): number {
        return this.writeFailures;
    }

    async flush(): Promise<void> {
        while (this.pending || this.drainPromise) {
            this.scheduleDrain();
            // eslint-disable-next-line no-await-in-loop -- a concurrent publish may enqueue one latest state during drain.
            await this.drainPromise;
        }
    }
}
