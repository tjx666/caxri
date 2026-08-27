import { readFile } from 'node:fs/promises';

import type {
    InternalFaultDiagnosis,
    InternalFaultEvidence,
    InternalProbeState,
} from '@caxri/system';
import {
    diagnoseInternalFault,
    internalFaultKinds,
    internalProbeStates,
    observationProcessManifestDirectory,
    readObservationProcessManifests,
} from '@caxri/system';

export type OwnerDiagnosticProbes = InternalFaultEvidence['probes'];

function parseProbes(value: unknown): OwnerDiagnosticProbes {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new TypeError('Owner diagnostic probes must be an object');
    const record = value as Record<string, unknown>;
    if (
        Object.keys(record).length !== internalFaultKinds.length ||
        internalFaultKinds.some(
            (kind) => !internalProbeStates.includes(record[kind] as InternalProbeState),
        )
    )
        throw new TypeError('Owner diagnostic probes must contain every fixed owner state');
    return Object.fromEntries(
        internalFaultKinds.map((kind) => [kind, record[kind] as InternalProbeState]),
    ) as OwnerDiagnosticProbes;
}

/**
 * Read-only parity classifier. It never starts, stops, repairs, cleans up, or reconnects a product process; callers own
 * the six content-free probe states and decide whether to act on the stable remediation category.
 */
export async function diagnoseRefactorOwner(options: {
    probes: OwnerDiagnosticProbes;
    processState?: InternalFaultEvidence['processState'];
    timestamp?: string;
    userDataPath: string;
}): Promise<InternalFaultDiagnosis> {
    const manifests = await readObservationProcessManifests(
        observationProcessManifestDirectory(options.userDataPath),
    );
    return diagnoseInternalFault({
        manifests,
        probes: options.probes,
        ...(options.processState && { processState: options.processState }),
        ...(options.timestamp && { timestamp: options.timestamp }),
    });
}

export async function readOwnerDiagnosticProbes(path: string): Promise<OwnerDiagnosticProbes> {
    return parseProbes(JSON.parse(await readFile(path, 'utf8')) as unknown);
}
