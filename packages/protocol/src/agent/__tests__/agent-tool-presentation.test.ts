import { describe, expect, it } from 'vitest';

import {
    agentToolActiveLabel,
    agentToolOutcomeLabel,
    describeAgentTool,
    formatNoticeableDuration,
    formatShortDuration,
    summarizeAgentToolGroup,
    unwrapShellCommand,
} from '../agent-tool-presentation';

describe('describeAgentTool', () => {
    it('maps Claude Code and Codex tools to a kind, a verb, and a subject', () => {
        expect(describeAgentTool({ name: 'Bash', summary: 'git status' })).toEqual({
            kind: 'command',
            label: 'Ran',
            subject: 'git status',
            isCodeSubject: true,
        });
        expect(describeAgentTool({ name: 'exec_command', summary: 'make' })).toMatchObject({
            kind: 'command',
        });
        expect(describeAgentTool({ name: 'apply_patch', summary: 'apply_patch' })).toEqual({
            kind: 'edit',
            label: 'Patched',
            subject: undefined,
            isCodeSubject: true,
        });
        expect(
            describeAgentTool({ name: 'WebFetch', summary: 'https://example.com' }),
        ).toMatchObject({
            kind: 'web',
            isCodeSubject: false,
        });
    });

    it('reads a shell read, search, or listing as that action', () => {
        const describe = (summary: string) => describeAgentTool({ name: 'Bash', summary });
        expect(describe("sed -n '1,40p' src/app.ts")).toEqual({
            kind: 'read',
            label: 'Read',
            subject: 'app.ts',
            isCodeSubject: true,
            path: 'src/app.ts',
        });
        expect(describe('/bin/zsh -lc "cat docs/a.md docs/b.md"')).toMatchObject({
            kind: 'read',
            subject: 'a.md, b.md',
        });
        expect(describe('head -n 40 src/app.ts')).toMatchObject({ subject: 'app.ts' });
        expect(describe('cd apps && nl -ba src/app.ts | sed -n 1,20p')).toMatchObject({
            kind: 'read',
            path: 'src/app.ts',
        });
        expect(describe("rg -n -g '*.ts' POLICY_VERSION src/hooks")).toMatchObject({
            kind: 'search',
            label: 'Searched',
            subject: 'POLICY_VERSION in hooks',
        });
        expect(describe('grep -rn "foo bar"')).toMatchObject({
            kind: 'search',
            subject: 'foo bar',
        });
        expect(describe('rg --files src')).toMatchObject({ kind: 'list', subject: 'src' });
        expect(describe('ls')).toMatchObject({ kind: 'list', label: 'Listed files' });
        expect(describe('find . -name "*.ts"')).toMatchObject({
            kind: 'list',
            label: 'Listed files',
        });
    });

    it('keeps any other command a command', () => {
        const describe = (summary: string) => describeAgentTool({ name: 'Bash', summary });
        for (const command of [
            'bun run test',
            'cat a.ts > b.ts',
            "sed -i 's/a/b/' app.ts",
            'sed s/a/b/ app.ts',
            'cat app.ts | bun run format',
            'ls && rm -rf build',
            'cat $FILE',
            'cat',
        ])
            expect(describe(command)).toMatchObject({
                kind: 'command',
                label: 'Ran',
                subject: command,
            });
    });

    it('shortens file paths to their name', () => {
        expect(describeAgentTool({ name: 'Read', summary: '/work/app/src/main.ts' })).toMatchObject(
            {
                kind: 'read',
                label: 'Read',
                subject: 'main.ts',
            },
        );
        expect(
            describeAgentTool({ name: 'Edit', summary: String.raw`C:\work\readme.md` }).subject,
        ).toBe('readme.md');
    });

    it('does not shorten non-path subjects of file tools', () => {
        expect(describeAgentTool({ name: 'Grep', summary: 'foo/bar' }).subject).toBe('foo/bar');
    });

    it('treats a summary equal to the name as no subject', () => {
        expect(describeAgentTool({ name: 'TodoWrite', summary: 'TodoWrite' })).toMatchObject({
            kind: 'plan',
            subject: undefined,
        });
    });

    it('names the MCP server and tool', () => {
        expect(describeAgentTool({ name: 'mcp__linear__get_issue', summary: 'x' })).toEqual({
            kind: 'mcp',
            label: 'linear',
            subject: 'get_issue',
            isCodeSubject: true,
        });
        expect(describeAgentTool({ name: 'linear/list_comments', summary: '{}' })).toEqual({
            kind: 'mcp',
            label: 'linear',
            subject: 'list_comments',
            isCodeSubject: true,
        });
    });

    it('titles a Computer Use step by the title the Agent wrote for it', () => {
        expect(describeAgentTool({ name: 'browserUse', summary: 'Open the router page' })).toEqual({
            kind: 'browser',
            label: 'Open the router page',
            isCodeSubject: false,
        });
        expect(describeAgentTool({ name: 'computerUse' })).toEqual({
            kind: 'computer',
            label: 'Used Computer Use',
            isCodeSubject: false,
        });
        expect(
            agentToolOutcomeLabel(
                describeAgentTool({ name: 'browserUse', summary: 'Click Save' }),
                'failed',
            ),
        ).toBe('Failed: Click Save');
        expect(
            summarizeAgentToolGroup([
                { name: 'browserUse', summary: 'a' },
                { name: 'browserUse', summary: 'b' },
                { name: 'computerUse', summary: 'c' },
            ]),
        ).toBe('Ran 2 browser steps, ran 1 Computer Use step');
    });

    it('falls back to the raw tool name for unknown tools', () => {
        expect(describeAgentTool({ name: 'CustomThing', summary: 'arg' })).toEqual({
            kind: 'other',
            label: 'CustomThing',
            subject: 'arg',
            isCodeSubject: true,
        });
    });
});

describe('summarizeAgentToolGroup', () => {
    it('counts kinds in first-seen order', () => {
        expect(
            summarizeAgentToolGroup([
                { name: 'Bash', summary: 'make' },
                { name: 'Read', summary: '/a.ts' },
                { name: 'Bash', summary: 'pwd' },
                { name: 'Grep', summary: 'x' },
            ]),
        ).toBe('Ran 2 commands, read 1 file, ran 1 search');
    });

    it('uses singular and irregular plurals', () => {
        expect(
            summarizeAgentToolGroup([
                { name: 'Grep', summary: 'a' },
                { name: 'Glob', summary: 'b' },
                { name: 'mcp__docs__read', summary: 'c' },
            ]),
        ).toBe('Ran 2 searches, called 1 MCP tool');
    });
});

describe('unwrapShellCommand', () => {
    it('returns the script a login shell ran', () => {
        expect(unwrapShellCommand(String.raw`/bin/zsh -lc "rg -n \"a|b\" src"`)).toBe(
            'rg -n "a|b" src',
        );
        expect(unwrapShellCommand(`bash -c 'ls -la'`)).toBe('ls -la');
        expect(unwrapShellCommand('git status')).toBe('git status');
    });
});

describe('formatShortDuration', () => {
    it('formats seconds and minutes', () => {
        expect(formatShortDuration(undefined)).toBeNull();
        expect(formatShortDuration(400)).toBe('<1s');
        expect(formatShortDuration(45_000)).toBe('45s');
        expect(formatShortDuration(120_000)).toBe('2m');
        expect(formatShortDuration(121_000)).toBe('2m 1s');
    });
});

describe('formatNoticeableDuration', () => {
    it('hides a missing or sub-second duration and formats anything longer', () => {
        expect(formatNoticeableDuration(undefined)).toBeNull();
        expect(formatNoticeableDuration(0)).toBeNull();
        expect(formatNoticeableDuration(999)).toBeNull();
        expect(formatNoticeableDuration(1000)).toBe('1s');
        expect(formatNoticeableDuration(65_000)).toBe('1m 5s');
    });
});

describe('agentToolActiveLabel', () => {
    it('uses a present-tense verb while the work runs', () => {
        expect(agentToolActiveLabel(describeAgentTool({ name: 'Bash', summary: 'make' }))).toBe(
            'Running',
        );
        expect(agentToolActiveLabel(describeAgentTool({ name: 'Read', summary: '/a.ts' }))).toBe(
            'Reading',
        );
        expect(agentToolActiveLabel(describeAgentTool({ name: 'docs/search', summary: 'x' }))).toBe(
            'docs',
        );
    });
});

describe('agentToolOutcomeLabel', () => {
    const edit = describeAgentTool({ name: 'Edit', summary: '/a.ts' });

    it('keeps the past tense for a completed call', () => {
        expect(agentToolOutcomeLabel(edit, 'completed')).toBe('Edited');
    });

    it('says in words that a call failed, was declined, or was stopped', () => {
        expect(agentToolOutcomeLabel(edit, 'failed')).toBe('Failed to edit');
        expect(agentToolOutcomeLabel(edit, 'declined')).toBe('Not allowed to edit');
        expect(agentToolOutcomeLabel(edit, 'interrupted')).toBe('Stopped editing');
        expect(agentToolOutcomeLabel(describeAgentTool({ name: 'Bash' }), 'failed')).toBe(
            'Failed to run',
        );
    });

    it('prefixes the outcome to a tool that has no verb', () => {
        const mcp = describeAgentTool({ name: 'mcp__github__create_issue' });
        expect(agentToolOutcomeLabel(mcp, 'failed')).toBe('Failed: github');
        expect(agentToolOutcomeLabel(mcp, 'declined')).toBe('Not allowed: github');
    });
});

describe('Codex subagent tools', () => {
    it('reads a wait as waiting for agents instead of the bare tool name', () => {
        for (const name of ['wait', 'wait_agent']) {
            const wait = describeAgentTool({ name, summary: '1 agent' });
            expect(wait).toEqual({
                kind: 'wait',
                label: 'Waited for agents',
                isCodeSubject: false,
            });
            expect(agentToolActiveLabel(wait)).toBe('Waiting for agents');
            expect(agentToolOutcomeLabel(wait, 'interrupted')).toBe('Stopped waiting for agents');
        }
    });

    it('names a multi-agent v2 subagent by its path, the way the Codex app does', () => {
        expect(
            describeAgentTool({ name: 'agentCompleted', summary: '/root/pr_watch_waiter' }),
        ).toEqual({
            kind: 'wait',
            label: 'Agent finished',
            subject: 'Pr watch waiter',
            isCodeSubject: false,
        });
        expect(
            describeAgentTool({ name: 'sendMessage', summary: '/root/acceptance-checker' }),
        ).toMatchObject({ kind: 'manage', label: 'Messaged agent', subject: 'Acceptance checker' });
        expect(
            describeAgentTool({ name: 'interruptAgent', summary: '/root/review_waiter' }),
        ).toMatchObject({ kind: 'manage', label: 'Stopped agent', subject: 'Review waiter' });
        // A v1 collab call's summary is a receiver count, not a name.
        expect(describeAgentTool({ name: 'closeAgent', summary: '2 agents' })).toEqual({
            kind: 'manage',
            label: 'Closed agent',
            isCodeSubject: false,
        });
    });

    it('summarizes a wait and the completion it returned as one wait', () => {
        expect(
            summarizeAgentToolGroup([
                { name: 'wait' },
                { name: 'agentCompleted', summary: '/root/pr_watch_waiter' },
            ]),
        ).toBe('Waited for agents');
    });

    it('does not count messages and stops to an agent as agents run or processes stopped', () => {
        expect(
            summarizeAgentToolGroup([
                { name: 'spawnAgent' },
                { name: 'sendMessage', summary: '/root/helper' },
                { name: 'sendMessage', summary: '/root/helper' },
                { name: 'closeAgent', summary: '/root/helper' },
            ]),
        ).toBe('Ran 1 agent, managed agents');
    });
});
