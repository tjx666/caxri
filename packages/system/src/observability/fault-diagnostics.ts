import process from 'node:process';

import type { CausalCapsule, FailureReason, RemediationCategory } from './causal-chain.js';
import { BoundedCausalChain } from './causal-chain.js';
import type { ObservationContext } from './context.js';
import type { ObservationOwner, ObservationPhase } from './metrics.js';
import type {
    ObservationProcessManifest,
    ObservationProcessManifests,
    ObservationProcessOwner,
} from './process-manifest.js';

export const internalFaultKinds = [
    'control',
    'server-core',
    'terminal-host',
    'extension-host',
    'persistence',
    'stream',
] as const;
export const internalProbeStates = ['healthy', 'failed', 'unknown'] as const;
export const observationProcessProbeStates = ['alive', 'dead', 'unknown'] as const;

export type InternalFaultKind = (typeof internalFaultKinds)[number];
export type InternalProbeState = (typeof internalProbeStates)[number];
export type ObservationProcessProbeState = (typeof observationProcessProbeStates)[number];

export interface InternalFaultEvidence {
    manifests: ObservationProcessManifests;
    probes: Record<InternalFaultKind, InternalProbeState>;
    processState?: (pid: number) => ObservationProcessProbeState;
    timestamp?: string;
}

export interface InternalFaultDiagnosis {
    chain: CausalCapsule[];
    classification: InternalFaultKind | 'healthy' | 'unknown';
}

interface FaultDescriptor {
    code: string;
    kind: InternalFaultKind;
    owner: ObservationOwner;
    phase: ObservationPhase;
    reason: FailureReason;
    remediation: RemediationCategory;
    retryable: boolean;
}

const descriptors: Record<InternalFaultKind, FaultDescriptor> = {
    'control': {
        code: 'CONTROL_UNREACHABLE',
        kind: 'control',
        owner: 'control',
        phase: 'probe',
        reason: 'control-unreachable',
        remediation: 'reconnect',
        retryable: true,
    },
    'server-core': {
        code: 'SERVER_CORE_UNAVAILABLE',
        kind: 'server-core',
        owner: 'server-core',
        phase: 'runtime',
        reason: 'core-unavailable',
        remediation: 'restart-core',
        retryable: true,
    },
    'terminal-host': {
        code: 'TERMINAL_HOST_UNAVAILABLE',
        kind: 'terminal-host',
        owner: 'terminal-host',
        phase: 'runtime',
        reason: 'terminal-host-exited',
        remediation: 'restart-terminal-host',
        retryable: true,
    },
    'extension-host': {
        code: 'EXTENSION_HOST_UNAVAILABLE',
        kind: 'extension-host',
        owner: 'extension-host',
        phase: 'runtime',
        reason: 'extension-host-exited',
        remediation: 'restart-extension-host',
        retryable: true,
    },
    'persistence': {
        code: 'PERSISTENCE_UNAVAILABLE',
        kind: 'persistence',
        owner: 'persistence',
        phase: 'commit',
        reason: 'persistence-unavailable',
        remediation: 'repair-persistence',
        retryable: false,
    },
    'stream': {
        code: 'STREAM_CLOSED',
        kind: 'stream',
        owner: 'stream',
        phase: 'transfer',
        reason: 'stream-closed',
        remediation: 'reconnect',
        retryable: true,
    },
};

function probeProcess(pid: number): ObservationProcessProbeState {
    try {
        process.kill(pid, 0);
        return 'alive';
    } catch (error) {
        const code =
            typeof error === 'object' && error !== null && 'code' in error
                ? String(Reflect.get(error, 'code'))
                : undefined;
        if (code === 'ESRCH') return 'dead';
        if (code === 'EPERM') return 'alive';
        return 'unknown';
    }
}

function manifestFor(
    manifests: ObservationProcessManifests,
    kind: InternalFaultKind,
): ObservationProcessManifest | undefined {
    return ['server-core', 'terminal-host', 'extension-host'].includes(kind)
        ? manifests[kind as ObservationProcessOwner]
        : manifests['server-core'];
}

function manifestContext(manifest: ObservationProcessManifest | undefined): ObservationContext {
    return manifest?.context ?? {};
}

function isManifestFailure(
    manifest: ObservationProcessManifest | undefined,
    processState: (pid: number) => ObservationProcessProbeState,
): boolean {
    if (!manifest) return false;
    return (
        manifest.state === 'failed' ||
        (manifest.state === 'ready' && processState(manifest.pid) === 'dead')
    );
}

function diagnosis(
    descriptor: FaultDescriptor,
    manifest: ObservationProcessManifest | undefined,
    timestamp: string | undefined,
): InternalFaultDiagnosis {
    const chain = new BoundedCausalChain();
    chain.record({
        code: descriptor.code,
        context: manifestContext(manifest),
        owner: descriptor.owner,
        phase: descriptor.phase,
        reason: descriptor.reason,
        remediation: descriptor.remediation,
        retryable: descriptor.retryable,
        timestamp,
    });
    return { chain: chain.snapshot(), classification: descriptor.kind };
}

/**
 * Produces one stable root-cause capsule from bounded manifests and content-free probe states. Core failure wins over a
 * simultaneously unreachable control endpoint; child owners then win over persistence and stream consequences.
 */
export function diagnoseInternalFault(evidence: InternalFaultEvidence): InternalFaultDiagnosis {
    const processState = evidence.processState ?? probeProcess;
    const core = evidence.manifests['server-core'];
    if (evidence.probes['server-core'] === 'failed' || isManifestFailure(core, processState))
        return diagnosis(descriptors['server-core'], core, evidence.timestamp);
    if (evidence.probes.control === 'failed')
        return diagnosis(descriptors.control, core, evidence.timestamp);
    for (const kind of ['terminal-host', 'extension-host'] as const) {
        const manifest = evidence.manifests[kind];
        if (evidence.probes[kind] === 'failed' || isManifestFailure(manifest, processState))
            return diagnosis(descriptors[kind], manifest, evidence.timestamp);
    }
    for (const kind of ['persistence', 'stream'] as const)
        if (evidence.probes[kind] === 'failed')
            return diagnosis(
                descriptors[kind],
                manifestFor(evidence.manifests, kind),
                evidence.timestamp,
            );
    return {
        chain: [],
        classification: Object.values(evidence.probes).every((state) => state === 'healthy')
            ? 'healthy'
            : 'unknown',
    };
}
