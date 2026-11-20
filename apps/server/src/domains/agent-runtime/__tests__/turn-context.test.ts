import type { AgentSessionInstructionSettings, AppLocale, TerminalRecord } from '@caxri/protocol';
import {
    agentDisplayLanguageInstruction,
    BUILT_IN_AGENT_SESSION_INSTRUCTIONS,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentLifecycleSignal } from '../../agents';
import type { CaxriDatabase } from '../../db';
import { AgentTurnContext } from '../turn-context';

const BOT = { projectId: 'bot-project', sessionId: 'bot-session' };

/**
 * Terminals `agent` (Terminal surface), `chat` (Chat surface), and `bot` (Caxri Bot's Terminal).
 */
function database(): CaxriDatabase {
    const terminals: Record<string, Partial<TerminalRecord>> = {
        agent: { id: 'agent', sessionId: 'session' },
        chat: { id: 'chat', sessionId: 'session', surface: 'chat' },
        bot: { id: 'bot', sessionId: BOT.sessionId },
    };
    return {
        getTerminal: (id: string) => terminals[id],
        getAppState: () => ({ ...BOT, terminalId: 'bot', sessionIds: [] }),
        getProject: (id: string) => (id === BOT.projectId ? { id } : undefined),
        getSession: (id: string) =>
            id === BOT.sessionId ? { projectId: BOT.projectId } : undefined,
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

const builtIn = (): AgentSessionInstructionSettings => ({ includeBuiltIn: true, custom: null });

describe('AgentTurnContext', () => {
    it('follows the Settings as they are at each delivery', () => {
        let settings: AgentSessionInstructionSettings = {
            includeBuiltIn: true,
            custom: 'Reply in haiku.',
        };
        const context = new AgentTurnContext(database(), () => settings);

        expect(context.for(signal())).toBe(
            `${BUILT_IN_AGENT_SESSION_INSTRUCTIONS}\n\nReply in haiku.`,
        );
        settings = { includeBuiltIn: false, custom: '  Answer in French.\n' };
        expect(context.for(signal({ launchId: 'launch-2' }))).toBe('Answer in French.');
        settings = builtIn();
        expect(context.for(signal({ launchId: 'launch-3' }))).toBe(
            BUILT_IN_AGENT_SESSION_INSTRUCTIONS,
        );
    });

    it('adds nothing when the user turned both off', () => {
        expect(
            new AgentTurnContext(
                database(),
                () => ({ includeBuiltIn: false, custom: ' \n ' }),
                () => 'zh-CN',
            ).for(signal()),
        ).toBeUndefined();
    });

    it("names Caxri's interface language as it is at each launch", () => {
        let locale: AppLocale = 'zh-CN';
        const context = new AgentTurnContext(database(), builtIn, () => locale);

        expect(context.for(signal())).toBe(
            `${BUILT_IN_AGENT_SESSION_INSTRUCTIONS}\n\n${agentDisplayLanguageInstruction('zh-CN')}`,
        );
        locale = 'en';
        expect(context.for(signal({ launchId: 'launch-2' }))).toContain(
            "Caxri's interface language is English.",
        );
    });

    it('adds the context to the first turn of each launch', () => {
        const context = new AgentTurnContext(database(), builtIn);

        expect(context.for(signal())).toBe(BUILT_IN_AGENT_SESSION_INSTRUCTIONS);
        expect(context.for(signal())).toBeUndefined();
        expect(context.for(signal({ launchId: 'launch-2' }))).toBe(
            BUILT_IN_AGENT_SESSION_INSTRUCTIONS,
        );
    });

    it('delivers it again when /clear starts a new provider session in the same launch', () => {
        const context = new AgentTurnContext(database(), builtIn);

        expect(context.for(signal({ agentSessionId: 'first' }))).toBe(
            BUILT_IN_AGENT_SESSION_INSTRUCTIONS,
        );
        expect(context.for(signal({ agentSessionId: 'first' }))).toBeUndefined();
        expect(context.for(signal({ agentSessionId: 'cleared' }))).toBe(
            BUILT_IN_AGENT_SESSION_INSTRUCTIONS,
        );
    });

    it('delivers it again after a main-agent compaction, not a subagent one', () => {
        const context = new AgentTurnContext(database(), builtIn);
        context.for(signal());

        context.observe(signal({ phase: 'compactionFinished', agentId: 'subagent' }));
        expect(context.for(signal())).toBeUndefined();
        context.observe(signal({ phase: 'compactionFinished' }));
        expect(context.for(signal())).toBe(BUILT_IN_AGENT_SESSION_INSTRUCTIONS);
    });

    it('delivers it again after the launch is forgotten', () => {
        const context = new AgentTurnContext(database(), builtIn);
        context.for(signal());
        context.forget('agent');

        expect(context.for(signal())).toBe(BUILT_IN_AGENT_SESSION_INSTRUCTIONS);
    });

    it.each([
        ['another phase', { phase: 'turnFinished' as const }],
        ['a provider that ignores prompt context', { provider: 'grok' as const }],
        ['a subagent turn', { agentId: 'subagent' }],
        ['an Agent Chat', { terminalId: 'chat' }],
        ['Caxri Bot', { terminalId: 'bot' }],
        ['an unknown Terminal', { terminalId: 'missing' }],
    ])('adds nothing for %s', (_label, overrides) => {
        expect(new AgentTurnContext(database(), builtIn).for(signal(overrides))).toBeUndefined();
    });
});
