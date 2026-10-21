import { describe, expect, it } from 'vitest';

import {
    agentToolActiveLabel,
    agentToolOutcomeLabel,
    describeAgentTool,
    formatNoticeableDuration,
    formatShortDuration,
    isNoticeableDuration,
    readableShellCommand,
    shortDurationParts,
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

    it('reads chained explorations as one, and a filtered file listing as finding files', () => {
        const describe = (summary: string) => describeAgentTool({ name: 'Bash', summary });
        expect(
            describe("sed -n '1,230p' src/config.ts && sed -n '1,220p' src/rotate.ts"),
        ).toMatchObject({ kind: 'read', subject: 'config.ts, rotate.ts' });
        expect(describe('cat a.ts; cat a.ts')).toMatchObject({ kind: 'read', path: 'a.ts' });
        expect(describe(String.raw`rg --files scripts/rotation | rg '\.test\.ts'"$"''`)).toEqual({
            kind: 'search',
            label: 'Found files',
            subject: String.raw`\.test\.ts$ in rotation`,
            isCodeSubject: true,
        });
        expect(describe('rtk rg -n TODO src')).toMatchObject({
            kind: 'search',
            subject: 'TODO in src',
        });
        // Different explorations chained together are still a plain command.
        expect(describe('cat a.ts && rg TODO')).toMatchObject({ kind: 'command' });
    });

    it("names a skill when Codex reads the skill's SKILL.md", () => {
        expect(
            describeAgentTool({ name: 'Bash', summary: 'cat .agents/skills/review/SKILL.md' }),
        ).toEqual({
            kind: 'skill',
            label: 'Used skill',
            subject: 'review',
            isCodeSubject: true,
            path: '.agents/skills/review/SKILL.md',
        });
        expect(
            describeAgentTool({ name: 'Read', summary: '/work/.claude/skills/review/SKILL.md' }),
        ).toMatchObject({ kind: 'skill', subject: 'review' });
        expect(describeAgentTool({ name: 'Bash', summary: 'cat SKILL.md' })).toMatchObject({
            kind: 'read',
        });
    });

    it('reads a test run by its targets, through rtk and package runners', () => {
        const describe = (summary: string) => describeAgentTool({ name: 'Bash', summary });
        expect(describe('rtk vitest run src/a.test.ts src/b.test.ts')).toEqual({
            kind: 'test',
            label: 'Ran tests',
            subject: 'a.test.ts, b.test.ts',
            isCodeSubject: true,
        });
        expect(
            describe('bunx vitest run -t "parses" -c vitest.config.ts src/a.test.ts'),
        ).toMatchObject({ kind: 'test', subject: 'a.test.ts' });
        expect(describe('CI=1 pnpm test:unit')).toMatchObject({
            kind: 'test',
            subject: 'pnpm test:unit',
        });
        for (const command of [
            'bun run test',
            'npm test',
            'bun test',
            'pnpm vitest',
            'uv run pytest tests/unit',
            'python -m pytest -k slow',
            'go test ./...',
            'cargo test',
            'bunx playwright test e2e/app.e2e.ts',
            'cd apps/server && rtk vitest run src/a.test.ts 2>&1 | tail -20',
        ])
            expect(describe(command)).toMatchObject({ kind: 'test', label: 'Ran tests' });
        expect(describe('go test ./internal/...')).toMatchObject({ subject: './internal/...' });
        for (const command of ['vitest bench', 'playwright install', 'bun scripts/test.ts'])
            expect(describe(command)).toMatchObject({ kind: 'command' });
    });

    it('reads a commit, push, or pull request step, with its message or title', () => {
        const describe = (summary: string) => describeAgentTool({ name: 'Bash', summary });
        expect(describe('git add -A && rtk git commit -m "fix(chat): stop waiting"')).toEqual({
            kind: 'commit',
            label: 'Committed',
            subject: 'fix(chat): stop waiting',
            isCodeSubject: false,
        });
        expect(
            describe(
                'git commit -m "$(cat <<\'EOF\'\nfeat: steer while waiting\n\nBody text.\nEOF\n)" && git push',
            ),
        ).toMatchObject({
            kind: 'commit',
            label: 'Committed and pushed',
            subject: 'feat: steer while waiting',
        });
        expect(describe('rtk git push -u origin feat/wait-steer')).toEqual({
            kind: 'push',
            label: 'Pushed',
            subject: 'feat/wait-steer',
            isCodeSubject: true,
        });
        expect(
            describe(
                'gh pr create --base main --title "Steer while waiting" --body-file /tmp/body.md',
            ),
        ).toMatchObject({
            kind: 'pullRequest',
            label: 'Opened PR',
            subject: 'Steer while waiting',
        });
        expect(describe('rtk gh pr merge 2383 --squash')).toMatchObject({
            label: 'Merged PR',
            subject: '#2383',
        });
        expect(
            describe('gh pr checks https://github.com/owner/project/pull/12 --watch'),
        ).toMatchObject({ label: 'Checked PR', subject: '#12' });
        for (const command of ['git status', 'git commit --amend && rm -rf out', 'gh pr list'])
            expect(describe(command)).toMatchObject({ kind: 'command' });
    });

    it('keeps any other command a command', () => {
        const describe = (summary: string) => describeAgentTool({ name: 'Bash', summary });
        for (const command of [
            'bun run build',
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

    it('counts every file a chained shell read covers', () => {
        expect(
            summarizeAgentToolGroup([
                {
                    name: 'shell',
                    summary: `/bin/zsh -lc "sed -n '1,80p' a.ts && sed -n '1,40p' b.ts"`,
                },
                { name: 'Read', summary: '/c.ts' },
            ]),
        ).toBe('Read 3 files');
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

describe('readableShellCommand', () => {
    it('drops output plumbing from every command in a chain', () => {
        expect(
            readableShellCommand(
                'npm view @scope/cli version 2>&1 | tail -1; tool --help 2>&1 | head -30; which tool 2>/dev/null',
            ),
        ).toBe('npm view @scope/cli version; tool --help; which tool');
    });
    it('keeps a filter that changes what the command shows', () => {
        expect(readableShellCommand("gh api repos/a/b | sed -n '/^## Install/,$p'")).toBe(
            "gh api repos/a/b | sed -n '/^## Install/,$p'",
        );
        expect(readableShellCommand('git log | head -n 5 | wc -l')).toBe(
            'git log | head -n 5 | wc -l',
        );
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

    it('agrees with isNoticeableDuration on the threshold', () => {
        expect(isNoticeableDuration(undefined)).toBe(false);
        expect(isNoticeableDuration(999)).toBe(false);
        expect(isNoticeableDuration(1000)).toBe(true);
    });
});

describe('shortDurationParts', () => {
    it('rounds to whole seconds the way formatShortDuration does', () => {
        expect(shortDurationParts(400)).toEqual({ minutes: 0, seconds: 0 });
        expect(shortDurationParts(59_600)).toEqual({ minutes: 1, seconds: 0 });
        expect(shortDurationParts(534_000)).toEqual({ minutes: 8, seconds: 54 });
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
        // The Server sends the bare name since it strips the `/root/` prefix for narrow rows.
        expect(describeAgentTool({ name: 'agentCompleted', summary: 'i18n_lint' })).toMatchObject({
            label: 'Agent finished',
            subject: 'I18n lint',
        });
        expect(describeAgentTool({ name: 'spawnAgent', summary: 'i18n_lint' })).toEqual({
            kind: 'agent',
            label: 'Started agent',
            subject: 'I18n lint',
            isCodeSubject: false,
        });
        // A v1 spawn's summary is its prompt, which stays as written.
        expect(describeAgentTool({ name: 'spawnAgent', summary: 'Review the diff' })).toMatchObject(
            { subject: 'Review the diff' },
        );
        // A v1 collab call's summary is a receiver count, not a name.
        expect(describeAgentTool({ name: 'closeAgent', summary: '2 agents' })).toEqual({
            kind: 'manage',
            label: 'Closed agent',
            isCodeSubject: false,
        });
    });

    it('summarizes a wait and the completion it returned as one wait on that subagent', () => {
        expect(
            summarizeAgentToolGroup([
                { name: 'wait' },
                { name: 'agentCompleted', summary: '/root/pr_watch_waiter' },
            ]),
        ).toBe('Waited for Pr watch waiter');
    });

    it('says whom a wait waited for when the Server names its subagent', () => {
        const wait = describeAgentTool({ name: 'wait', summary: 'Review the diff' });
        expect(wait).toEqual({
            kind: 'wait',
            label: 'Waited for',
            subject: 'Review the diff',
            isCodeSubject: false,
        });
        expect(agentToolActiveLabel(wait)).toBe('Waiting for');
        expect(summarizeAgentToolGroup([{ name: 'wait', summary: 'Review the diff' }])).toBe(
            'Waited for Review the diff',
        );
        expect(
            summarizeAgentToolGroup([
                { name: 'exec_command', summary: 'git status' },
                { name: 'wait', summary: 'Review the diff' },
                { name: 'wait', summary: 'Review the diff' },
            ]),
        ).toBe('Ran 1 command, waited for Review the diff');
        // Waits on different subagents keep the plain phrase.
        expect(
            summarizeAgentToolGroup([
                { name: 'wait', summary: 'Review the diff' },
                { name: 'wait', summary: 'Lint' },
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
