import { randomUUID } from 'node:crypto';

import { vi } from 'vitest';

import type { AgentLifecycleSignal } from '../../agents';
import { fixture } from '../retry/__tests__/fixture';

type NoticeSink = (
    terminalId: string,
    launchId: string,
    text: string,
    done: (isAccepted: boolean) => void,
) => boolean;

/**
 * A Session the caller delegated into, completed, then taken over by the user typing in its Terminal: the state a
 * hand-back starts from. The caller is a Chat (so its notices need no PTY proof) and the child a PTY Agent whose
 * finished turn is reported as a lifecycle signal. `idle` stands for the coordinator's idle proof of the child.
 */
export async function takenOverSession() {
    const idle = { value: true };
    const deliveries: string[] = [];
    const deliverNotice = vi.fn<NoticeSink>((_terminalId, _launchId, text, done) => {
        deliveries.push(text);
        done(true);
        return true;
    });
    let callerTerminalId = '';
    const f = await fixture({
        deliverNotice,
        noticeTiming: { quietMs: 5, recheckMs: 20 },
        isIdle: () => idle.value,
        isChatTerminal: (terminalId) => terminalId === callerTerminalId,
        chatCallerState: () => 'idle',
    });
    callerTerminalId = f.callerTerminalId;
    const id = randomUUID();
    const receipt = await f.service.create(id, f.authority, {
        projectId: f.project.id,
        provider: 'claude',
        prompt: 'Synthetic task',
        newSession: true,
        title: 'Child work',
    });
    const sessionId = receipt.sessionId;
    const terminal = f.database.listTerminals(sessionId)[0];
    f.service.bindLaunch(terminal.id, 'child-launch');
    const started = f.stored(id);
    const providerSessionId = started.providerSessionId;
    if (!providerSessionId) throw new Error('Started delegation has no provider Session id');
    f.database.rebindAgentSession(terminal.id, 'claude', providerSessionId);
    f.database.agentDelegations.save({
        ...started,
        turnId: 'turn-1',
        receipt: { ...started.receipt, status: 'completed' },
    });
    const signal = (phase: 'turnFinished' | 'turnStarted', turn = 'turn-1') =>
        ({
            terminalId: terminal.id,
            launchId: 'child-launch',
            provider: 'claude',
            agentSessionId: providerSessionId,
            agentTurnId: turn,
            phase,
        }) as unknown as AgentLifecycleSignal;
    f.service.observe(signal('turnFinished'));
    // The user types in the child's Terminal: the takeover mark, durable and dated.
    f.service.interruptTerminal(terminal.id, true);
    const followUp = (followUpId = randomUUID()) =>
        f.service.create(followUpId, f.authority, {
            projectId: f.project.id,
            sessionId,
            provider: 'claude',
            prompt: 'Synthetic follow-up',
            followUpOf: id,
        });
    const grants = () => f.database.agentDelegations.handBacks.forSessions([sessionId]);
    const noticeFor = (grantId: string) =>
        f.database.agentDelegations.notices.get(`handback:${grantId}`);
    return {
        ...f,
        deliveries,
        followUp,
        grants,
        id,
        idle,
        noticeFor,
        sessionId,
        signal,
        terminal,
    };
}
