import { randomUUID } from 'node:crypto';

import { onTestFinished, vi } from 'vitest';

import type { AgentLifecycleSignal } from '../../agents';
import { SettlementNotices } from '../settlement-notice/service';
import { fixture } from './retry.fixture';

type DeliverNotice = NonNullable<
    ConstructorParameters<typeof SettlementNotices>[0]['deliverNotice']
>;

export const QUIET_MS = 100;
export const RECHECK_MS = 1000;

/**
 * A caller that delegated one task, with notices over the real database and fake timers. `chat` and `isIdle` stand for
 * the caller Chat's projection and a PTY Agent's idle proof.
 */
export async function setup(options: { isChat?: boolean } = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const f = await fixture();
    const { isChat = true } = options;
    const state = {
        chat: 'idle' as 'idle' | 'busy' | 'paused' | undefined,
        isIdle: true,
        epoch: 0,
        launch: 'caller-launch' as string | undefined,
        isDecidable: false,
        isQuestionOpen: false,
    };
    const deliveries: Array<{ text: string; done: (isAccepted: boolean) => void }> = [];
    const deliverNotice = vi.fn<DeliverNotice>((_terminalId, _launchId, text, done) => {
        deliveries.push({ text, done });
        return true;
    });
    const notices = new SettlementNotices(
        {
            database: f.database,
            logger: { write: f.loggerWrite } as never,
            currentLaunchId: (terminalId) =>
                terminalId === f.callerTerminalId ? state.launch : undefined,
            isChatTerminal: () => isChat,
            chatCallerState: () => state.chat,
            inputEpoch: () => state.epoch,
            isIdle: () => state.isIdle,
            deliverNotice,
            noticeTiming: { quietMs: QUIET_MS, recheckMs: RECHECK_MS },
        },
        {
            isApprovalDecidable: () => state.isDecidable,
            isQuestionWithParent: () => state.isQuestionOpen,
        },
    );
    onTestFinished(() => notices.close());
    const create = async (title = 'Child work') => {
        const id = randomUUID();
        await f.service.create(id, f.authority, {
            projectId: f.project.id,
            provider: 'claude',
            prompt: 'Synthetic task',
            newSession: true,
            title,
        });
        const record = f.database.agentDelegations.get(id)!;
        notices.recorded(record, undefined);
        return id;
    };
    const settle = (id: string, status: 'completed' | 'failed' = 'completed', extra = {}) => {
        const before = f.database.agentDelegations.get(id)!;
        const saved = f.database.agentDelegations.save({
            ...before,
            receipt: { ...before.receipt, status, ...extra },
        });
        notices.recorded(saved, before.receipt);
    };
    const stateOf = (key: string) => f.database.agentDelegations.notices.get(key)?.state;
    const logged = (outcome: string) =>
        f.loggerWrite.mock.calls.filter(
            (call) => (call[2] as { fields?: { outcome?: string } }).fields?.outcome === outcome,
        );
    return { ...f, create, deliveries, deliverNotice, logged, notices, settle, state, stateOf };
}

export const passSignal = (
    terminalId: string,
    phase: 'turnFinished' | 'turnStarted',
    launchId = 'caller-launch',
) => ({ terminalId, launchId, phase, agentTurnId: 'turn-1' }) as unknown as AgentLifecycleSignal;
