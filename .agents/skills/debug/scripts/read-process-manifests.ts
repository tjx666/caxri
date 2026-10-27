/**
 * Reads the lifecycle manifests Server Core, Terminal Host, and Extension Host publish under
 * `<userData>/observability/processes/`, for diagnosing a Caxri whose Server no longer answers. Each manifest holds the
 * process's last lifecycle state, pid, its latest metric aggregates (`process.memory`, `process.open_fds`,
 * `queue.wait`, `persistence.latency`, ...), and its last content-safe failure capsule. The script adds whether each
 * pid is still alive and the root-cause classification `diagnoseInternalFault` derives from the manifests alone.
 *
 * Usage: `bun run .agents/skills/debug/scripts/read-process-manifests.ts --user-data-dir <absolute path>`
 *
 * Read-only: it never starts, stops, signals, or repairs a process, never writes a file, and prints neither the
 * userData path nor any log text. A `classification` of `unknown` means the manifests show no fault, not that the
 * processes are healthy.
 */
import { isAbsolute } from 'node:path';
import process from 'node:process';

import type {
    CausalCapsule,
    InternalFaultDiagnosis,
    ObservationContext,
    ObservationMetricRegistrySnapshot,
    ObservationProcessManifest,
    ObservationProcessManifests,
    ObservationProcessOwner,
    ObservationProcessProbeState,
    ObservationProcessState,
} from '@caxri/system';
import {
    diagnoseInternalFault,
    internalFaultKinds,
    observationProcessManifestDirectory,
    observationProcessManifestPath,
    observationProcessOwners,
    readObservationProcessManifest,
} from '@caxri/system';

interface ProcessManifestReport {
    state: ObservationProcessState;
    pid: number;
    /**
     * `null` when the probe could not tell, such as an unexpected `kill(pid, 0)` error.
     */
    pidAlive: boolean | null;
    startedAt: string;
    updatedAt: string;
    context: ObservationContext;
    metrics: ObservationMetricRegistrySnapshot | null;
    failure: CausalCapsule | null;
}

export interface ProcessManifestsReport {
    owners: Partial<Record<ObservationProcessOwner, ProcessManifestReport>>;
    /**
     * Owners with no manifest: the process never started under this userData, or its file was removed.
     */
    missing: ObservationProcessOwner[];
    /**
     * Owners whose manifest exists but was refused, with the reason (malformed, oversized, not private, another
     * user's).
     */
    unreadable: Partial<Record<ObservationProcessOwner, string>>;
    diagnosis: InternalFaultDiagnosis;
}

function probeProcess(pid: number): ObservationProcessProbeState {
    try {
        process.kill(pid, 0);
        return 'alive';
    } catch (error) {
        const code = errorCode(error);
        if (code === 'ESRCH') return 'dead';
        // EPERM means the pid exists but belongs to someone else.
        if (code === 'EPERM') return 'alive';
        return 'unknown';
    }
}

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

/**
 * The manifest reader's own refusals carry fixed messages; a file system error names the path, so only its code is
 * kept.
 */
function refusal(error: unknown): string {
    const code = errorCode(error);
    if (code) return `unreadable (${code})`;
    return error instanceof Error ? error.message : 'unreadable';
}

function report(
    manifest: ObservationProcessManifest,
    processState: (pid: number) => ObservationProcessProbeState,
): ProcessManifestReport {
    const alive = processState(manifest.pid);
    return {
        state: manifest.state,
        pid: manifest.pid,
        pidAlive: alive === 'unknown' ? null : alive === 'alive',
        startedAt: new Date(manifest.startedAt).toISOString(),
        updatedAt: manifest.updatedAt,
        context: manifest.context,
        metrics: manifest.metrics ?? null,
        failure: manifest.failure ?? null,
    };
}

export async function readProcessManifests(
    userDataDirectory: string,
    processState: (pid: number) => ObservationProcessProbeState = probeProcess,
): Promise<ProcessManifestsReport> {
    const directory = observationProcessManifestDirectory(userDataDirectory);
    const manifests: ObservationProcessManifests = {};
    const result: ProcessManifestsReport = {
        owners: {},
        missing: [],
        unreadable: {},
        diagnosis: { chain: [], classification: 'unknown' },
    };
    for (const owner of observationProcessOwners) {
        try {
            // eslint-disable-next-line no-await-in-loop -- three small files, read in owner order.
            const manifest = await readObservationProcessManifest(
                observationProcessManifestPath(directory, owner),
            );
            manifests[owner] = manifest;
            result.owners[owner] = report(manifest, processState);
        } catch (error) {
            if (errorCode(error) === 'ENOENT') result.missing.push(owner);
            else result.unreadable[owner] = refusal(error);
        }
    }
    // Every live probe is `unknown`, so only manifest evidence (a `failed` state, or `starting`/`ready` with a dead pid)
    // can name a faulted owner.
    result.diagnosis = diagnoseInternalFault({
        manifests,
        probes: Object.fromEntries(internalFaultKinds.map((kind) => [kind, 'unknown'])) as Record<
            (typeof internalFaultKinds)[number],
            'unknown'
        >,
        processState,
    });
    return result;
}

export function parseUserDataDirectory(arguments_: readonly string[]): string {
    const index = arguments_.indexOf('--user-data-dir');
    const value = index === -1 ? undefined : arguments_[index + 1];
    if (!value || !isAbsolute(value))
        throw new Error(
            'Usage: read-process-manifests.ts --user-data-dir <absolute path to the Caxri userData directory>',
        );
    return value;
}

async function main(): Promise<void> {
    const userData = parseUserDataDirectory(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await readProcessManifests(userData), null, 2)}\n`);
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
