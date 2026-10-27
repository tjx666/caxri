import type { TerminalRecord } from '@caxri/protocol';
import { DEFAULT_AGENT_SESSION_INSTRUCTIONS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentLifecycleSignal } from '../../agents';
import type { CaxriDatabase } from '../../db';
import { AgentTurnContext } from '../turn-context';

const COMMANDER = { projectId: 'commander-project', sessionId: 'commander-session' };

/**
 * Terminals `agent` (Terminal surface), `chat` (Chat surface), and `commander` (the Agent Commander's Terminal).
 */
function database(): CaxriDatabase {
    const terminals: Record<string, Partial<TerminalRecord>> = {
        agent: { id: 'agent', sessionId: 'session' },
        chat: { id: 'chat', sessionId: 'session', surface: 'chat' },
        commander: { id: 'commander', sessionId: COMMANDER.sessionId },
    };
    return {
        getTerminal: (id: string) => terminals[id],
        getAppState: () => ({ ...COMMANDER, terminalId: 'commander', sessionIds: [] }),
        getProject: (id: string) => (id === COMMANDER.projectId ? { id } : undefined),
        getSession: (id: string) =>
            id === COMMANDER.sessionId ? { projectId: COMMANDER.projectId } : undefined,
    } as unknown as CaxriDatabase;
}

function signal(overrides: Partial<AgentLifecycleSignal> = {}): AgentLifecycleSignal {
    return {
        provider: 'codex',
        phase: 'turnStarted',
        terminalId: 'agent',
        launchId: 'launch-1',
        ...overrides,
    };
}

const preset = () => null;

describe('AgentTurnContext', () => {
    it('adds the instructions the user wrote in Settings, read at each launch', () => {
        let instructions: string | null = 'Reply in haiku.';
        const context = new AgentTurnContext(database(), () => instructions);

        expect(context.for(signal())).toBe('Reply in haiku.');
        instructions = '  Answer in French.\n';
        expect(context.for(signal({ launchId: 'launch-2' }))).toBe('Answer in French.');
        instructions = null;
        expect(context.for(signal({ launchId: 'launch-3' }))).toBe(
            DEFAULT_AGENT_SESSION_INSTRUCTIONS,
        );
    });

    it('adds nothing when the user cleared the instructions', () => {
        expect(new AgentTurnContext(database(), () => ' \n ').for(signal())).toBeUndefined();
    });

    it('adds the context to the first turn of each launch', () => {
        const context = new AgentTurnContext(database(), preset);

        expect(context.for(signal())).toBe(DEFAULT_AGENT_SESSION_INSTRUCTIONS);
        expect(context.for(signal())).toBeUndefined();
        expect(context.for(signal({ launchId: 'launch-2' }))).toBe(
            DEFAULT_AGENT_SESSION_INSTRUCTIONS,
        );
    });

    it('delivers it again after the launch is forgotten', () => {
        const context = new AgentTurnContext(database(), preset);
        context.for(signal());
        context.forget('agent');

        expect(context.for(signal())).toBe(DEFAULT_AGENT_SESSION_INSTRUCTIONS);
    });

    it.each([
        ['another phase', { phase: 'turnFinished' as const }],
        ['a provider that ignores prompt context', { provider: 'grok' as const }],
        ['a subagent turn', { agentId: 'subagent' }],
        ['an Agent Chat', { terminalId: 'chat' }],
        ['the Agent Commander', { terminalId: 'commander' }],
        ['an unknown Terminal', { terminalId: 'missing' }],
    ])('adds nothing for %s', (_label, overrides) => {
        expect(new AgentTurnContext(database(), preset).for(signal(overrides))).toBeUndefined();
    });
});
