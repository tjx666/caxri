import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ArgvConfig, ArgvConfigChanges } from '@caxri/protocol';
import { z } from 'zod';

import { updateArgvConfig } from './argv-config';

const GPU_CONTEXT_LOSS_WINDOW_MS = 24 * 60 * 60 * 1_000;
const GPU_CONTEXT_LOSS_THRESHOLD = 2;
const MAX_RETAINED_INCIDENTS = 8;

const persistedGpuIncidentSchema = z.strictObject({
    correlationId: z.string().min(1).max(128),
    occurredAt: z.number().int().nonnegative(),
});

const persistedGpuSafeModeStateSchema = z.strictObject({
    version: z.literal(1),
    automatic: z.boolean(),
    correlationId: z.string().min(1).max(128).nullable(),
    incidents: z.array(persistedGpuIncidentSchema).max(MAX_RETAINED_INCIDENTS),
});

type PersistedGpuSafeModeState = z.infer<typeof persistedGpuSafeModeStateSchema>;

const EMPTY_STATE: PersistedGpuSafeModeState = {
    version: 1,
    automatic: false,
    correlationId: null,
    incidents: [],
};

export interface GpuSafeModeBootState {
    active: boolean;
    automatic: boolean;
    correlationId?: string;
}

interface GpuSafeModeControllerOptions {
    now?: () => number;
    updateBootConfig?: (userDataPath: string, changes: ArgvConfigChanges) => Promise<ArgvConfig>;
    userDataPath: string;
}

export function gpuSafeModeStatePath(userDataPath: string): string {
    return join(userDataPath, 'config', 'gpu-safe-mode.json');
}

function currentIncidents(
    incidents: PersistedGpuSafeModeState['incidents'],
    now: number,
): PersistedGpuSafeModeState['incidents'] {
    const cutoff = now - GPU_CONTEXT_LOSS_WINDOW_MS;
    return incidents.filter(
        (incident) => incident.occurredAt >= cutoff && incident.occurredAt <= now,
    );
}

function parseState(source: string): PersistedGpuSafeModeState {
    const result = persistedGpuSafeModeStateSchema.safeParse(JSON.parse(source));
    return result.success ? result.data : { ...EMPTY_STATE, incidents: [] };
}

function readStateAtBoot(userDataPath: string): PersistedGpuSafeModeState {
    try {
        // oxlint-disable-next-line node/no-sync -- Safe Mode must be known before Chromium starts
        return parseState(readFileSync(gpuSafeModeStatePath(userDataPath), 'utf8'));
    } catch {
        return { ...EMPTY_STATE, incidents: [] };
    }
}

async function readState(userDataPath: string): Promise<PersistedGpuSafeModeState> {
    try {
        return parseState(await readFile(gpuSafeModeStatePath(userDataPath), 'utf8'));
    } catch {
        return { ...EMPTY_STATE, incidents: [] };
    }
}

async function writeState(userDataPath: string, state: PersistedGpuSafeModeState): Promise<void> {
    const path = gpuSafeModeStatePath(userDataPath);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(state)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

/**
 * Reads only the strict, content-free circuit-breaker receipt before Chromium starts. Unknown fields fail closed so
 * paths, Terminal output, environment values, and other accidental content can never become diagnostic state.
 */
export function readGpuSafeModeAtBoot(userDataPath: string): GpuSafeModeBootState {
    const state = readStateAtBoot(userDataPath);
    if (!state.automatic || !state.correlationId) return { active: false, automatic: false };
    return {
        active: true,
        automatic: true,
        correlationId: state.correlationId,
    };
}

/**
 * Serializes incident receipts and user overrides for one profile. The rolling window accepts only already-decoded GPU
 * context losses; ordinary Renderer/utility exits cannot cross this typed boundary.
 */
export function createGpuSafeModeController(options: GpuSafeModeControllerOptions) {
    const now = options.now ?? Date.now;
    const updateBootConfig = options.updateBootConfig ?? updateArgvConfig;
    let queue = Promise.resolve<unknown>(undefined);

    function enqueue<T>(task: () => Promise<T>): Promise<T> {
        const previous = queue;
        const next = (async () => {
            try {
                await previous;
            } catch {
                // A failed predecessor reached its caller; only ordering must survive here.
            }
            return task();
        })();
        queue = next;
        return next;
    }

    return {
        clear: (): Promise<void> =>
            enqueue(() => writeState(options.userDataPath, { ...EMPTY_STATE, incidents: [] })),
        drain: async (): Promise<void> => {
            try {
                await queue;
            } catch {
                // The operation's caller owns its failure; shutdown only waits for the ordered queue to settle.
            }
        },
        recordContextLoss: (correlationId: string) =>
            enqueue(async () => {
                const occurredAt = now();
                const previous = await readState(options.userDataPath);
                const incidents = [
                    ...currentIncidents(previous.incidents, occurredAt),
                    { correlationId, occurredAt },
                ].slice(-MAX_RETAINED_INCIDENTS);
                const activated =
                    previous.automatic || incidents.length >= GPU_CONTEXT_LOSS_THRESHOLD;
                const activeCorrelationId = activated
                    ? (previous.correlationId ?? correlationId)
                    : null;
                await writeState(options.userDataPath, {
                    version: 1,
                    automatic: activated,
                    correlationId: activeCorrelationId,
                    incidents,
                });
                if (activated && !previous.automatic)
                    await updateBootConfig(options.userDataPath, {
                        hardwareAcceleration: false,
                    });
                return {
                    activated,
                    count: incidents.length,
                    ...(activated && { correlationId: activeCorrelationId! }),
                    newlyActivated: activated && !previous.automatic,
                };
            }),
        updateArgvConfig: (changes: ArgvConfigChanges): Promise<ArgvConfig> =>
            enqueue(async () => {
                const config = await updateBootConfig(options.userDataPath, changes);
                /**
                 * Preserve automatic protection until enabling hardware acceleration is durably accepted. If clearing
                 * the marker fails afterward, the next boot remains safely in software mode instead of losing history.
                 */
                if (changes.hardwareAcceleration === true)
                    await writeState(options.userDataPath, { ...EMPTY_STATE, incidents: [] });
                return config;
            }),
    };
}
