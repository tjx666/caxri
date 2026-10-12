import type { SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentLifecycleSignal } from '../../agents';
import { CommanderCompletionNotifier } from '../completion-notice';
import { commanderRowReader } from './commander-rows-fake';
import { pendingStore } from './pending-notices-fake';

const COMMANDER_TERMINAL_ID = 'commander-terminal';

/**
 * A notifier whose only observable output is the persisted `interrupted_turn` marker the next launch prompt reads.
 */
function markerFixture() {
    const notices = pendingStore();
    let epoch = 0;
    const notifier = new CommanderCompletionNotifier({
        database: {
            agentCommanderRows: () => ({
                projectId: 'commander-project',
                sessionId: 'commander-session',
                sessionIds: [],
                terminalId: COMMANDER_TERMINAL_ID,
            }),
            ...commanderRowReader(() => COMMANDER_TERMINAL_ID),
            getSession: () => ({ projectId: 'commander-project' }) as SessionRecord,
            commanderPendingNotices: notices,
        },
        hasIdleProof: () => false,
        inputEpoch: () => epoch,
        write: () => true,
    });
    return {
        apply(signal: Partial<AgentLifecycleSignal> & Pick<AgentLifecycleSignal, 'phase'>) {
            notifier.onLifecycleApplied({
                launchId: 'launch-1',
                provider: 'codex',
                terminalId: COMMANDER_TERMINAL_ID,
                ...signal,
            });
        },
        hasMarker: () => notices.list().some((notice) => notice.kind === 'interrupted_turn'),
        notifier,
        type(data: string, terminalId = COMMANDER_TERMINAL_ID) {
            epoch += 1;
            notifier.observeInput(terminalId, data);
        },
    };
}

describe('CommanderCompletionNotifier interrupted-turn marker', () => {
    it('marks only a main-thread turn as interrupted until it finishes, fails, or the user stops the Commander', () => {
        const f = markerFixture();
        f.apply({ phase: 'turnStarted', agentId: 'subagent-1' });
        expect(f.hasMarker()).toBe(false);

        f.apply({ phase: 'turnStarted' });
        expect(f.hasMarker()).toBe(true);
        f.apply({ phase: 'turnFinished', agentTurnId: 'turn-1' });
        expect(f.hasMarker()).toBe(false);

        f.apply({ phase: 'turnStarted' });
        f.apply({ phase: 'turnFailed' });
        expect(f.hasMarker()).toBe(false);

        f.apply({ phase: 'turnStarted' });
        f.notifier.onStopped();
        expect(f.hasMarker()).toBe(false);
    });

    it('does not offer to continue a turn the user interrupted with Escape, which Codex ends without Stop (#1740)', () => {
        const f = markerFixture();
        f.apply({ phase: 'turnStarted' });
        f.type('\u{1B}', 'other-terminal');
        f.type('\u{1B}[A');
        expect(f.hasMarker()).toBe(true);

        f.type('\u{1B}');
        expect(f.hasMarker()).toBe(false);
        expect(f.notifier.launchPrompt(COMMANDER_TERMINAL_ID)).toBeUndefined();
    });

    it('marks the turn again when a main-thread tool signal shows the Escape did not interrupt it', () => {
        const f = markerFixture();
        f.apply({ phase: 'turnStarted' });
        f.type('\u{1B}');
        // Neither a subagent, an older launch, nor a session signal proves the main turn of this launch still runs.
        f.apply({ phase: 'shellToolStarted', agentId: 'subagent-1' });
        f.apply({ phase: 'shellToolStarted', launchId: 'launch-0' });
        f.apply({ phase: 'sessionIdentified' });
        expect(f.hasMarker()).toBe(false);

        f.apply({ phase: 'shellToolFinished' });
        expect(f.hasMarker()).toBe(true);
        expect(f.notifier.launchPrompt(COMMANDER_TERMINAL_ID)).toContain(
            'previous turn did not finish',
        );
    });

    it('keeps a finished turn unmarked when a tool signal arrives after the Escape was superseded', () => {
        const f = markerFixture();
        f.apply({ phase: 'turnStarted' });
        f.type('\u{1B}');
        f.apply({ phase: 'turnFinished', agentTurnId: 'turn-1' });
        f.apply({ phase: 'toolBatchFinished' });
        expect(f.hasMarker()).toBe(false);
    });
});
