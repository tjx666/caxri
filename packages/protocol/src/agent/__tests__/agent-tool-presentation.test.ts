import { describe, expect, it } from 'vitest';

import {
    describeAgentTool,
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
        expect(describeAgentTool({ name: 'exec_command', summary: 'ls' })).toMatchObject({
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
                { name: 'Bash', summary: 'ls' },
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
