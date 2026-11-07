import { describe, expect, it } from 'vitest';

import type { AgentChatItem } from '../../agent-chat-contract';
import type { AgentChatWorkItem } from '../../agent-chat-work';
import {
    agentChatWorkSummaryGlyph,
    agentChatWorkSummaryPhrases,
    isAgentChatWorkSummaryNamingStep,
    summarizeAgentChatWork,
} from '../agent-chat-work-summary';

const command = (id: string, turnId?: string, text = 'git status'): AgentChatItem => ({
    id,
    ...(turnId && { turnId }),
    type: 'command',
    command: text,
    status: 'completed',
    output: '',
});
const read = (id: string, turnId?: string): Extract<AgentChatItem, { type: 'toolCall' }> => ({
    id,
    ...(turnId && { turnId }),
    type: 'toolCall',
    name: 'Read',
    summary: '/work/src/app.ts',
    status: 'completed',
});
const thought = (id: string, turnId?: string): AgentChatItem => ({
    id,
    ...(turnId && { turnId }),
    type: 'reasoning',
    text: 'thinking',
    streaming: false,
});

describe('agentChatWorkSummaryPhrases', () => {
    const command: AgentChatWorkItem = {
        id: 'command',
        type: 'command',
        command: 'printf done',
        output: '',
        status: 'completed',
    };
    const failed: AgentChatWorkItem = { ...command, id: 'failed', status: 'failed' };
    const edit: AgentChatWorkItem = {
        id: 'edit',
        type: 'fileChange',
        changes: [{ path: 'src/app.ts', kind: 'update', diff: '' }],
        status: 'completed',
    };

    it('keys one phrase per kind, so a count change keeps its key and a new kind adds one', () => {
        expect(agentChatWorkSummaryPhrases([command])).toEqual([
            { key: 'command', text: 'Ran 1 command' },
        ]);
        expect(agentChatWorkSummaryPhrases([command, command, edit])).toEqual([
            { key: 'command', text: 'Ran 2 commands' },
            { key: 'edit', text: ', edited 1 file' },
        ]);
    });

    it('names the current step of an open group between calls and counts only once it ends', () => {
        const second: AgentChatWorkItem = { ...command, id: 'second', command: 'printf second' };
        const reasoning: AgentChatWorkItem = {
            id: 'reasoning',
            type: 'reasoning',
            text: '',
            streaming: false,
        };
        expect(
            agentChatWorkSummaryPhrases([command, second, reasoning], undefined, { isOpen: true }),
        ).toEqual([{ key: 'active', text: 'Running printf second' }]);
        expect(agentChatWorkSummaryPhrases([command, second])).toEqual([
            { key: 'command', text: 'Ran 2 commands' },
        ]);
    });

    it('carries earlier failures in the title of an open group instead of a failure glyph on the current step', () => {
        const running: AgentChatWorkItem = {
            ...command,
            id: 'running',
            command: 'bun run x',
            status: 'running',
        };
        const items = [failed, { ...failed, id: 'failed-2' }, running];
        const phrases = agentChatWorkSummaryPhrases(items, undefined, { isOpen: true });
        expect(phrases).toEqual([
            { key: 'active', text: 'Running bun run x' },
            { key: 'failures', text: ', 2 failed' },
        ]);
        expect(isAgentChatWorkSummaryNamingStep(phrases)).toBe(true);
        const settled = agentChatWorkSummaryPhrases([failed, command]);
        expect(isAgentChatWorkSummaryNamingStep(settled)).toBe(false);
    });

    it('counts the other calls running beside the one the title names', () => {
        const first: AgentChatWorkItem = {
            ...command,
            id: 'first',
            command: 'printf first',
            status: 'running',
        };
        const second: AgentChatWorkItem = { ...first, id: 'second', command: 'printf second' };
        const third: AgentChatWorkItem = { ...first, id: 'third', command: 'printf third' };
        expect(
            agentChatWorkSummaryPhrases([first, second, third], undefined, { isOpen: true }),
        ).toEqual([{ key: 'active', text: 'Running printf third and 2 more' }]);
        // The newest call ends first: the title names a call still running and counts the rest.
        const settled: AgentChatWorkItem = { ...third, status: 'completed' };
        expect(
            agentChatWorkSummaryPhrases([first, second, settled], undefined, { isOpen: true }),
        ).toEqual([{ key: 'active', text: 'Running printf second and 1 more' }]);
        expect(
            agentChatWorkSummaryPhrases([first, { ...second, status: 'completed' }, settled]),
        ).toEqual([{ key: 'active', text: 'Running printf first' }]);
    });

    it('leads parallel calls of different kinds with the generic work glyph', () => {
        const running: AgentChatWorkItem = { ...command, status: 'running' };
        const reading: AgentChatWorkItem = { ...edit, status: 'running' };
        expect(agentChatWorkSummaryGlyph([running, reading], { isOpen: true })).toEqual({
            kind: 'other',
        });
        expect(
            agentChatWorkSummaryGlyph([running, { ...running, id: 'again' }], { isOpen: true }),
        ).toEqual({
            kind: 'command',
        });
    });

    it('ends with the failure count and joins into the summary text', () => {
        const phrases = agentChatWorkSummaryPhrases([edit, failed]);
        expect(phrases.at(-1)).toEqual({ key: 'failures', text: ', 1 failed' });
        expect(phrases.map(({ text }) => text).join('')).toBe(
            summarizeAgentChatWork([edit, failed]),
        );
    });
});

describe('summarizeAgentChatWork', () => {
    it('shows the current command while running and counts work only after it settles', () => {
        const first: AgentChatWorkItem = {
            id: 'first',
            type: 'command',
            command: 'printf first',
            output: '',
            status: 'running',
        };
        const second: AgentChatWorkItem = {
            id: 'second',
            type: 'command',
            command: 'printf second',
            output: '',
            status: 'running',
        };
        expect(summarizeAgentChatWork([first])).toBe('Running printf first');
        expect(summarizeAgentChatWork([first, second])).toBe('Running printf second and 1 more');
        expect(summarizeAgentChatWork([first, { ...second, status: 'completed' }])).toBe(
            'Running printf first',
        );
        expect(
            summarizeAgentChatWork([
                { ...first, status: 'completed' },
                { ...second, status: 'completed' },
            ]),
        ).toBe('Ran 2 commands');
    });

    it('shows the active action and target for tools other than commands', () => {
        expect(summarizeAgentChatWork([{ ...read('read'), status: 'running' }])).toBe(
            'Reading app.ts',
        );
        expect(
            summarizeAgentChatWork([
                {
                    id: 'edit',
                    type: 'fileChange',
                    status: 'running',
                    changes: [{ path: '/work/src/app.ts', kind: 'update', diff: '' }],
                },
            ]),
        ).toBe('Editing app.ts');
    });

    it('counts tools by kind and only names reasoning when it is alone', () => {
        const items = [thought('r'), command('c1'), command('c2'), read('x')] as Parameters<
            typeof summarizeAgentChatWork
        >[0];
        expect(summarizeAgentChatWork(items)).toBe('Ran 2 commands, read 1 file');
        expect(
            summarizeAgentChatWork([thought('r')] as Parameters<typeof summarizeAgentChatWork>[0]),
        ).toBe('Thought');
    });

    it('counts failed and declined items at the end', () => {
        const items = [
            command('c1'),
            { ...command('c2'), status: 'failed' },
            { ...read('x'), status: 'declined' },
        ] as Parameters<typeof summarizeAgentChatWork>[0];
        expect(summarizeAgentChatWork(items)).toBe('Ran 2 commands, read 1 file, 2 failed');
    });
});
