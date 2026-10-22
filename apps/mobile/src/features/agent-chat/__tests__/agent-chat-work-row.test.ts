import type { AgentChatItem, AgentChatWorkItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatWorkRowPresentation } from '../agent-chat-work-row';

type Command = Extract<AgentChatItem, { type: 'command' }>;

const command = (overrides: Partial<Command> = {}): AgentChatWorkItem => ({
    id: 'c1',
    turnId: 't1',
    type: 'command',
    command: 'echo approved',
    output: '',
    status: 'completed',
    ...overrides,
});

describe('agentChatWorkRowPresentation', () => {
    it('reads in the present tense while a command runs or awaits approval, and past tense once done', () => {
        const pending = agentChatWorkRowPresentation(command({ status: 'running' }));
        expect(pending).toMatchObject({
            isRunning: true,
            subject: 'echo approved',
            verb: 'Running',
        });
        expect(pending.accessibilityLabel).toBe('Running echo approved. Open detail.');

        const done = agentChatWorkRowPresentation(command());
        expect(done).toMatchObject({ isRunning: false, verb: 'Ran' });
        expect(done.accessibilityLabel).toBe('Ran echo approved. Open detail.');
    });

    it("titles a command with the Agent's description", () => {
        const row = agentChatWorkRowPresentation(
            command({ command: 'git status --short', description: 'Show working tree status' }),
        );
        expect(row).toMatchObject({
            isCodeSubject: false,
            subject: 'Show working tree status',
            verb: 'Ran',
        });
    });

    it('names a non-zero exit code and the failure without flagging a clean exit', () => {
        const failed = agentChatWorkRowPresentation(command({ exitCode: 2, status: 'failed' }));
        expect(failed.failedExitCode).toBe(2);
        expect(failed.accessibilityLabel).toBe(
            'Failed to run echo approved. Exit 2. Failed. Open detail.',
        );
        expect(agentChatWorkRowPresentation(command({ exitCode: 0 })).failedExitCode).toBe(
            undefined,
        );
    });

    it('tags a command moved to the background', () => {
        const row = agentChatWorkRowPresentation(command({ background: true }));
        expect(row.background).toBe(true);
        expect(row.accessibilityLabel).toBe('Ran echo approved. Background. Open detail.');
        expect(agentChatWorkRowPresentation(command()).background).toBe(false);
    });

    it('keeps the trailing facts off a row still running', () => {
        const row = agentChatWorkRowPresentation(
            command({ background: true, exitCode: 1, status: 'running' }),
        );
        expect(row.background).toBe(false);
        expect(row.failedExitCode).toBe(undefined);
    });
});

describe('agentChatWorkRowPresentation for MCP tool calls', () => {
    const mcpCall: AgentChatWorkItem = {
        id: 'm1',
        turnId: 't1',
        type: 'toolCall',
        name: 'exa/web_search_exa',
        status: 'completed',
    };

    it('keeps the server name in the title while the row has no server icon', () => {
        const row = agentChatWorkRowPresentation(mcpCall);
        expect(row.kind).toBe('mcp');
        expect(`${row.verb} ${row.subject ?? ''}`).toContain('exa');
    });

    it('titles the row by the tool alone once the server icon shows, as Desktop does', () => {
        const row = agentChatWorkRowPresentation(mcpCall, undefined, true);
        expect(row).toMatchObject({ kind: 'mcp', verb: 'Web search exa' });
        expect(row.subject).toBeUndefined();
    });
});

describe('agentChatWorkRowPresentation for a subagent call', () => {
    const agentCall: AgentChatWorkItem = {
        id: 'a1',
        turnId: 't1',
        type: 'toolCall',
        name: 'Task',
        status: 'completed',
    };

    it('says Ran agent once the subagent ended', () => {
        expect(agentChatWorkRowPresentation(agentCall)).toMatchObject({
            isRunning: false,
            verb: 'Ran agent',
        });
    });

    it('says Running agent while the subagent it started still runs', () => {
        expect(agentChatWorkRowPresentation(agentCall, undefined, false, true)).toMatchObject({
            isRunning: true,
            verb: 'Running agent',
        });
    });
});
