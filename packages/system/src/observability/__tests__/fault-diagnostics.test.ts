import { describe, expect, it } from 'vitest';

import type { InternalFaultEvidence, InternalFaultKind } from '../fault-diagnostics';
import { diagnoseInternalFault, internalFaultKinds } from '../fault-diagnostics';
import type {
    ObservationProcessManifest,
    ObservationProcessManifests,
    ObservationProcessOwner,
} from '../process-manifest';

const expected = {
    'control': ['control', 'probe', 'control-unreachable', 'reconnect'],
    'server-core': ['server-core', 'runtime', 'core-unavailable', 'restart-core'],
    'terminal-host': ['terminal-host', 'runtime', 'terminal-host-exited', 'restart-terminal-host'],
    'extension-host': [
        'extension-host',
        'runtime',
        'extension-host-exited',
        'restart-extension-host',
    ],
    'persistence': ['persistence', 'commit', 'persistence-unavailable', 'repair-persistence'],
    'stream': ['stream', 'transfer', 'stream-closed', 'reconnect'],
} as const satisfies Record<InternalFaultKind, readonly string[]>;

function manifest(owner: ObservationProcessOwner): ObservationProcessManifest {
    return {
        context: {
            bootId: 'boot-1',
            buildId: 'build-1',
            processId: owner === 'server-core' ? 41 : owner === 'terminal-host' ? 42 : 43,
            serverId: 'server-1',
        },
        owner,
        pid: owner === 'server-core' ? 41 : owner === 'terminal-host' ? 42 : 43,
        schemaVersion: 1,
        startedAt: 1,
        state: 'ready',
        updatedAt: '2026-08-26T00:00:00.000Z',
    };
}

function evidence(failed: InternalFaultKind): InternalFaultEvidence {
    const probes = Object.fromEntries(
        internalFaultKinds.map((kind) => [kind, kind === failed ? 'failed' : 'healthy']),
    ) as InternalFaultEvidence['probes'];
    const manifests: ObservationProcessManifests = {
        'extension-host': manifest('extension-host'),
        'server-core': manifest('server-core'),
        'terminal-host': manifest('terminal-host'),
    };
    return {
        manifests,
        probes,
        processState: () => 'alive',
        timestamp: '2026-08-26T00:00:00.000Z',
    };
}

describe('architecture-a6-agent-observability', () => {
    it.each(internalFaultKinds)(
        'classifies seeded %s failures with one bounded capsule',
        (kind) => {
            const result = diagnoseInternalFault(evidence(kind));

            expect(result.classification).toBe(kind);
            expect(result.chain).toHaveLength(1);
            expect([
                result.chain[0].owner,
                result.chain[0].phase,
                result.chain[0].reason,
                result.chain[0].remediation,
            ]).toEqual(expected[kind]);
            expect(result.chain[0].context).toMatchObject({
                bootId: 'boot-1',
                buildId: 'build-1',
                serverId: 'server-1',
            });
            expect(Object.keys(result.chain[0])).not.toContain('message');
            expect(Object.keys(result.chain[0])).not.toContain('payload');
            expect(Object.keys(result.chain[0])).not.toContain('path');
        },
    );

    it('attributes an unreachable endpoint to a dead Core before control', () => {
        const input = evidence('control');
        input.processState = () => 'dead';

        expect(diagnoseInternalFault(input).classification).toBe('server-core');
    });

    it('reports healthy and inconclusive probes without inventing a failure', () => {
        const healthy = evidence('control');
        healthy.probes.control = 'healthy';
        expect(diagnoseInternalFault(healthy)).toEqual({ chain: [], classification: 'healthy' });
        healthy.probes.stream = 'unknown';
        expect(diagnoseInternalFault(healthy)).toEqual({ chain: [], classification: 'unknown' });
    });
});
