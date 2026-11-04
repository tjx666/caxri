import { describe, expect, it } from 'vitest';

import type { StoredAgentDelegation } from '../../../db';
import { ParentPresence } from '../../parent-presence';
import { hopEvidence, walkChain } from '../evidence';
import { requestFingerprint } from '../fingerprint';

interface Task {
    id: string;
    terminalId: string;
    callerTerminalId?: string;
    callerLaunchId?: string;
    parentDelegationId?: string;
    depth?: number;
    status?: string;
    hasHumanIntervention?: boolean;
    inputEpoch?: number;
    launchId?: string;
}

const stored = (task: Task) =>
    ({
        receipt: {
            delegationId: task.id,
            terminalId: task.terminalId,
            callerTerminalId: task.callerTerminalId,
            parentDelegationId: task.parentDelegationId,
            depth: task.depth,
            status: task.status ?? 'running',
        },
        callerLaunchId: task.callerLaunchId,
        launchId: task.launchId,
        hasHumanIntervention: task.hasHumanIntervention,
        inputEpoch: task.inputEpoch ?? 0,
    }) as unknown as StoredAgentDelegation;

/**
 * Root agent R delegated A (task t1, depth 1); A delegated B (task t2, depth 2); B delegated the child (task t3, depth
 * 3). `walkChain` starts at t3 and lists B, A, R.
 */
function chain(overrides: Record<string, Partial<Task>> = {}, epochs: Record<string, number> = {}) {
    const tasks: Record<string, Task> = {
        t1: {
            id: 't1',
            terminalId: 'A',
            callerTerminalId: 'R',
            callerLaunchId: 'R1',
            depth: 1,
            launchId: 'A1',
        },
        t2: {
            id: 't2',
            terminalId: 'B',
            callerTerminalId: 'A',
            callerLaunchId: 'A1',
            parentDelegationId: 't1',
            depth: 2,
            launchId: 'B1',
        },
        t3: {
            id: 't3',
            terminalId: 'C',
            callerTerminalId: 'B',
            callerLaunchId: 'B1',
            parentDelegationId: 't2',
            depth: 3,
            launchId: 'C1',
        },
    };
    for (const [id, fields] of Object.entries(overrides)) Object.assign(tasks[id], fields);
    const host = {
        database: {
            agentDelegations: {
                get: (id: string) => (id in tasks ? stored(tasks[id]) : undefined),
            },
        },
        inputEpoch: (terminalId: string) => epochs[terminalId] ?? 0,
    } as unknown as Parameters<typeof walkChain>[0];
    return { host, child: stored(tasks.t3) };
}

describe('walkChain', () => {
    it('lists every Agent above the task, nearest first, and proves the lineage', () => {
        const { host, child } = chain();

        const walked = walkChain(host, child);

        expect(walked.lineageProven).toBe(true);
        expect(walked.hops).toMatchObject([
            { terminalId: 'B', launchId: 'B1', delegationId: 't2', taskState: 'intact' },
            { terminalId: 'A', launchId: 'A1', delegationId: 't1', taskState: 'intact' },
            { terminalId: 'R', launchId: 'R1', taskState: 'intact' },
        ]);
    });

    it('marks the intermediate Agent whose own task a person took over', () => {
        const { host, child } = chain({ t2: { hasHumanIntervention: true } });

        expect(walkChain(host, child).hops.map((hop) => hop.taskState)).toEqual([
            'taken_over',
            'intact',
            'intact',
        ]);
    });

    it('marks an intermediate Agent whose Terminal took input after its task began', () => {
        const { host, child } = chain({}, { A: 5 });

        expect(walkChain(host, child).hops.map((hop) => hop.taskState)).toEqual([
            'intact',
            'taken_over',
            'intact',
        ]);
    });

    it('marks an intermediate Agent whose own task ended', () => {
        const { host, child } = chain({ t2: { status: 'completed' } });

        expect(walkChain(host, child).hops[0].taskState).toBe('inactive');
    });

    it.each([
        ['a missing caller launch', { t3: { callerLaunchId: undefined } }],
        ['a missing caller Terminal', { t3: { callerTerminalId: undefined } }],
        ['a parent record that is gone', { t3: { parentDelegationId: 'gone' } }],
        ['a parent in another Terminal', { t2: { terminalId: 'X' } }],
        ['a parent on another launch', { t3: { callerLaunchId: 'other' } }],
        ['a depth that does not step down by one', { t2: { depth: 5 } }],
        ['a repeated record', { t2: { parentDelegationId: 't3' } }],
    ])('does not prove the lineage for %s', (_name, overrides) => {
        const { host, child } = chain(overrides);

        expect(walkChain(host, child).lineageProven).toBe(false);
    });
});

describe('hopEvidence', () => {
    const terminal = { surface: 'chat', provider: 'codex' };
    const host = (permissionLaunch: string, live = 'R1') => ({
        database: { getTerminal: () => terminal } as never,
        currentLaunchId: () => live,
        appliedPermission: () => ({
            launchId: permissionLaunch,
            permissionMode: 'fullAccess' as const,
            planMode: false,
            applied: true,
        }),
    });
    const hop = { terminalId: 'R', launchId: 'R1', taskState: 'intact' as const };

    it('proves the launch only when the live launch, the hop, and the permission read agree', () => {
        expect(hopEvidence(host('R1'), hop)).toMatchObject({
            surface: 'chat',
            provider: 'codex',
            launchProven: true,
            mode: 'fullAccess',
        });
        expect(hopEvidence(host('R2'), hop).launchProven).toBe(false);
        expect(hopEvidence(host('R1', 'R2'), hop).launchProven).toBe(false);
    });

    it('carries no mode when the permission is not applied', () => {
        const unapplied = {
            ...host('R1'),
            appliedPermission: () => ({ launchId: 'R1', planMode: false, applied: false }),
        };

        expect(hopEvidence(unapplied, hop)).toMatchObject({ modeUnapplied: true });
        expect(hopEvidence(unapplied, hop).mode).toBeUndefined();
    });
});

describe('requestFingerprint', () => {
    const command = { id: 'r', kind: 'command' as const, command: 'ls', cwd: '/a' };

    it('is stable across key order and absent fields', () => {
        expect(requestFingerprint(command, { accept: true, decline: true })).toBe(
            requestFingerprint(
                { cwd: '/a', command: 'ls', kind: 'command', id: 'r', reason: undefined },
                { decline: true, accept: true },
            ),
        );
    });

    it.each([
        ['the command', { ...command, command: 'rm' }],
        ['the working directory', { ...command, cwd: '/b' }],
        ['a network host', { ...command, networkHost: 'example.test' }],
        ['the decisions list', { ...command, decisions: ['accept' as const] }],
        ['the reason', { ...command, reason: 'why' }],
    ])('changes with %s', (_name, changed) => {
        expect(requestFingerprint(changed, { accept: true, decline: true })).not.toBe(
            requestFingerprint(command, { accept: true, decline: true }),
        );
    });

    it('changes with the offered decisions and tells absent offers from none offered', () => {
        const both = requestFingerprint(command, { accept: true, decline: true });
        expect(requestFingerprint(command, { accept: true, decline: false })).not.toBe(both);
        expect(requestFingerprint(command, undefined)).not.toBe(
            requestFingerprint(command, { accept: false, decline: false }),
        );
    });
});

describe('ParentPresence', () => {
    const host = (terminals: Record<string, string | undefined>) => ({
        hasTerminal: (terminalId: string) => terminalId in terminals,
        currentLaunchId: (terminalId: string) => terminals[terminalId],
    });

    it('is gone when the Terminal is deleted, the launch retired, or another launch is live', () => {
        const presence = new ParentPresence(host({ T: 'L1', U: 'L2' }));

        expect(presence.isGone('missing', 'L1')).toBe(true);
        expect(presence.isGone('T', 'L1')).toBe(false);
        expect(presence.isGone('U', 'L1')).toBe(true);
        presence.retire('L1');
        expect(presence.isGone('T', 'L1')).toBe(true);
    });

    it('is not gone while the launch is only starting or unknown', () => {
        const presence = new ParentPresence(host({ T: undefined }));

        expect(presence.isGone('T', 'L1')).toBe(false);
        expect(presence.isGone('T', undefined)).toBe(false);
        expect(presence.isGone(undefined, 'L1')).toBe(false);
    });

    it('remembers a bounded number of retirements', () => {
        const live = { T: 'old-0', U: 'old-299' };
        const presence = new ParentPresence(host(live));
        for (let index = 0; index < 300; index++) presence.retire(`old-${index}`);

        expect(presence.isGone('T', 'old-0')).toBe(false);
        expect(presence.isGone('U', 'old-299')).toBe(true);
    });
});
