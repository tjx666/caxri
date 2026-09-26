import { describe, expect, it } from 'vitest';

import { describeTool, summarizeToolGroup } from '../tool-presentation';

describe('describeTool', () => {
    it('maps Claude Code and Codex tools to a kind, a verb, and a subject', () => {
        expect(describeTool({ name: 'Bash', summary: 'git status' })).toEqual({
            kind: 'command',
            label: 'Ran',
            subject: 'git status',
            isCodeSubject: true,
        });
        expect(describeTool({ name: 'exec_command', summary: 'ls' })).toMatchObject({
            kind: 'command',
        });
        expect(describeTool({ name: 'apply_patch', summary: 'apply_patch' })).toEqual({
            kind: 'edit',
            label: 'Patched',
            subject: undefined,
            isCodeSubject: true,
        });
        expect(describeTool({ name: 'WebFetch', summary: 'https://example.com' })).toMatchObject({
            kind: 'web',
            isCodeSubject: false,
        });
    });

    it('shortens file paths to their name', () => {
        expect(describeTool({ name: 'Read', summary: '/work/app/src/main.ts' })).toMatchObject({
            kind: 'read',
            label: 'Read',
            subject: 'main.ts',
        });
        expect(describeTool({ name: 'Edit', summary: String.raw`C:\work\readme.md` }).subject).toBe(
            'readme.md',
        );
    });

    it('does not shorten non-path subjects of file tools', () => {
        expect(describeTool({ name: 'Grep', summary: 'foo/bar' }).subject).toBe('foo/bar');
    });

    it('treats a summary equal to the name as no subject', () => {
        expect(describeTool({ name: 'TodoWrite', summary: 'TodoWrite' })).toMatchObject({
            kind: 'plan',
            subject: undefined,
        });
    });

    it('names the MCP server and tool', () => {
        expect(describeTool({ name: 'mcp__linear__get_issue', summary: 'x' })).toEqual({
            kind: 'mcp',
            label: 'linear',
            subject: 'get_issue',
            isCodeSubject: true,
        });
    });

    it('falls back to the raw tool name for unknown tools', () => {
        expect(describeTool({ name: 'CustomThing', summary: 'arg' })).toEqual({
            kind: 'other',
            label: 'CustomThing',
            subject: 'arg',
            isCodeSubject: true,
        });
    });
});

describe('summarizeToolGroup', () => {
    it('counts kinds in first-seen order', () => {
        expect(
            summarizeToolGroup([
                { name: 'Bash', summary: 'ls' },
                { name: 'Read', summary: '/a.ts' },
                { name: 'Bash', summary: 'pwd' },
                { name: 'Grep', summary: 'x' },
            ]),
        ).toBe('Ran 2 commands, read 1 file, ran 1 search');
    });

    it('uses singular and irregular plurals', () => {
        expect(
            summarizeToolGroup([
                { name: 'Grep', summary: 'a' },
                { name: 'Glob', summary: 'b' },
                { name: 'mcp__docs__read', summary: 'c' },
            ]),
        ).toBe('Ran 2 searches, called 1 MCP tool');
    });
});
