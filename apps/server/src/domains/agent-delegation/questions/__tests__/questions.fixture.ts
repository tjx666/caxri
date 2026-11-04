import type { DelegationQuestionChanged } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { vi } from 'vitest';

import { delegatedFixture } from '../../__tests__/delegated-sessions.fixture';
import type { DelegationAuthority } from '../../admission';
import type { AgentDelegationServiceOptions } from '../../service-options';

/**
 * A delegating Agent (the fixture's caller) and a delegated child Agent running a started task, with a launch ID per
 * Terminal so a test can retire the parent's launch without touching the child's. Every event and log line the Server
 * emits is captured for privacy assertions.
 */
export async function questionFixture(
    overrides: Partial<AgentDelegationServiceOptions> = {},
    { isStarted = true, flags = {} }: { isStarted?: boolean; flags?: { independent?: true } } = {},
) {
    const launches = new Map<string, string>();
    const changes: DelegationQuestionChanged[] = [];
    const write = vi.fn<StructuredLogger['write']>();
    const f = await delegatedFixture({
        currentLaunchId: (terminalId) => launches.get(terminalId),
        onQuestionChanged: (change) => changes.push(change),
        logger: { write } as unknown as StructuredLogger,
        ...overrides,
    });
    const parentTerminalId = f.authority.callerTerminalId;
    launches.set(parentTerminalId, 'parent-launch');
    const task = await f.delegate(flags);
    /**
     * `isStarted: false` leaves the child in its startup, launch bound but its first turn not begun, where the user's
     * input answers a startup prompt instead of taking the task over.
     */
    if (isStarted) f.start(task);
    else f.service.bindChatLaunch(task.terminalId, 'startup-launch', task.id);
    const childLaunchId = f.database.agentDelegations.get(task.id)!.launchId!;
    launches.set(task.terminalId, childLaunchId);

    const child = (generation = 1): DelegationAuthority => ({
        principal: {
            kind: 'agent',
            id: 'child-agent',
            endpointId: 'child-agent',
            generation,
            projectIds: [f.project.id],
        },
        callerTerminalId: task.terminalId,
    });
    const owner: DelegationAuthority = { principal: { kind: 'human-cli', id: 'owner' } };
    const { questions } = f.service;
    const ask = (
        text = 'Synthetic private question?',
        extra: { options?: string[]; requestId?: string } = {},
    ) => questions.ask(child(), { text, ...extra });
    /**
     * Everything the Server wrote about questions: events and log lines, serialized, for privacy assertions.
     */
    const observed = () => JSON.stringify({ changes, logs: write.mock.calls });
    const entries = (event: string) =>
        write.mock.calls.filter((call) => call[1] === event).map((call) => call[2]?.fields);
    return {
        ...f,
        ask,
        changes,
        child,
        childLaunchId,
        entries,
        launches,
        observed,
        owner,
        parent: f.authority,
        parentTerminalId,
        questions,
        task,
    };
}
