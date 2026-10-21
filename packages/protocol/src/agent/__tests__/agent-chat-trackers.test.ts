import { describe, expect, it } from 'vitest';

import type { AgentChatItem } from '../agent-chat-contract';
import {
    agentChatTrackerExcerpt,
    trackerExcerptText,
    trackerReferenceText,
} from '../agent-chat-tracker-artifact';
import { agentChatTrackerShellWords, collectAgentChatTrackers } from '../agent-chat-trackers';

const command = (
    id: string,
    text: string,
    output: string,
    status: 'completed' | 'failed' = 'completed',
): AgentChatItem => ({ id, type: 'command', command: text, status, output });

const tool = (
    id: string,
    name: string,
    summary: string | undefined,
    output: string,
): AgentChatItem => ({
    id,
    type: 'toolCall',
    name,
    status: 'completed',
    ...(summary && { summary }),
    output,
});

describe('agentChatTrackerShellWords', () => {
    it('groups quotes and keeps a heredoc substitution as one word', () => {
        expect(
            agentChatTrackerShellWords(
                `gh pr create --title "Fix the bar" --body "$(cat <<'EOF'\nLine one\nEOF\n)" && echo done`,
            ),
        ).toEqual([
            'gh',
            'pr',
            'create',
            '--title',
            'Fix the bar',
            '--body',
            "$(cat <<'EOF'\nLine one\nEOF\n)",
        ]);
        expect(agentChatTrackerShellWords(`gh issue edit 2 -t 'it''s'; ls`)).toEqual([
            'gh',
            'issue',
            'edit',
            '2',
            '-t',
            'its',
        ]);
    });
});

describe('agentChatTrackerExcerpt', () => {
    it('skips headings and markers to the first line of prose', () => {
        expect(agentChatTrackerExcerpt('## Summary\n\n- Adds the **card** view\n- More')).toBe(
            'Adds the card view',
        );
        expect(agentChatTrackerExcerpt('   \n')).toBeUndefined();
    });
});

describe('collectAgentChatTrackers', () => {
    it('reads a created pull request from gh, with its title and heredoc body', () => {
        const run = `/bin/zsh -lc "gh pr create --title \\"Add cards\\" --body \\"$(cat <<'EOF'\n## Summary\nShow cards under replies.\nEOF\n)\\""`;
        expect(
            collectAgentChatTrackers([
                command(
                    'c1',
                    run,
                    'Creating pull request\nhttps://github.com/acme/widgets/pull/42\n',
                ),
            ]),
        ).toEqual([
            {
                provider: 'github',
                kind: 'pull',
                action: 'created',
                url: 'https://github.com/acme/widgets/pull/42',
                reference: 'acme/widgets#42',
                title: 'Add cards',
                excerpt: 'Show cards under replies.',
            },
        ]);
    });

    it('reads an edited issue and ignores failed or unrelated commands', () => {
        expect(
            collectAgentChatTrackers([
                command(
                    'c1',
                    'cd app; gh issue edit 2 --title "Renamed"',
                    'https://github.com/acme/widgets/issues/2\n',
                ),
                command(
                    'c2',
                    'gh issue create --title x',
                    'https://github.com/acme/widgets/issues/3',
                    'failed',
                ),
                command('c3', 'gh pr view 4', 'https://github.com/acme/widgets/pull/4'),
                command('c4', 'gh pr edit 5', 'no url printed'),
                command(
                    'c5',
                    'git commit -m "explain gh pr edit" && gh pr view 6',
                    'https://github.com/acme/widgets/pull/6',
                ),
            ]),
        ).toEqual([
            {
                provider: 'github',
                kind: 'issue',
                action: 'updated',
                url: 'https://github.com/acme/widgets/issues/2',
                reference: 'acme/widgets#2',
                title: 'Renamed',
            },
        ]);
    });

    it('does not call a pull request created when a || fallback may have printed its URL', () => {
        const url = 'https://github.com/acme/widgets/pull/7';
        const create = 'gh pr create --title "Add widget" --fill';
        const existing = `a pull request for branch "feat" into branch "main" already exists:\n${url}`;
        expect(
            collectAgentChatTrackers([
                // The create failed because the pull request exists; `gh pr view` printed the URL again.
                command('c1', `${create} || gh pr view --json url -q .url`, `${existing}\n${url}`),
                // The create's own error was discarded, so the URL alone cannot say which command printed it.
                command('c2', `${create} 2>/dev/null || gh pr view --json url -q .url`, url),
            ]),
        ).toEqual([]);
        // A fallback that edits the existing pull request is still an update.
        expect(
            collectAgentChatTrackers([
                command(
                    'c3',
                    `${create} || gh pr edit --title "Add widget"`,
                    `${existing}\n${url}`,
                ),
            ]),
        ).toMatchObject([{ action: 'updated', url, title: 'Add widget' }]);
        // Without a sign of failure, the create printed the URL and its fallback never ran.
        expect(
            collectAgentChatTrackers([
                command('c4', `${create} || gh pr view --json url -q .url`, url),
            ]),
        ).toMatchObject([{ action: 'created', url, title: 'Add widget' }]);
    });

    it('reads GitHub and Linear MCP results, falling back to JSON arguments', () => {
        const github = tool(
            'm1',
            'github/create_issue',
            JSON.stringify({ owner: 'acme', repo: 'widgets', title: 'From args' }),
            JSON.stringify({
                html_url: 'https://github.com/acme/widgets/issues/7',
                number: 7,
                body: 'Body text',
            }),
        );
        const linear = tool(
            'm2',
            'mcp__linear__save_issue',
            'Some description',
            JSON.stringify({
                issue: {
                    identifier: 'ENG-12',
                    title: 'Linear title',
                    url: 'https://linear.app/acme/issue/ENG-12/linear-title',
                    description: 'Linear body',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:02.000Z',
                },
            }),
        );
        const updatedLinear = tool(
            'm3',
            'linear/save_issue',
            JSON.stringify({ id: 'ENG-13', title: 'Edited' }),
            'Saved https://linear.app/acme/issue/ENG-13/edited',
        );
        expect(collectAgentChatTrackers([github, linear, updatedLinear])).toEqual([
            {
                provider: 'github',
                kind: 'issue',
                action: 'created',
                url: 'https://github.com/acme/widgets/issues/7',
                reference: 'acme/widgets#7',
                title: 'From args',
                excerpt: 'Body text',
            },
            {
                provider: 'linear',
                kind: 'issue',
                action: 'created',
                url: 'https://linear.app/acme/issue/ENG-12/linear-title',
                reference: 'ENG-12',
                title: 'Linear title',
                excerpt: 'Linear body',
            },
            {
                provider: 'linear',
                kind: 'issue',
                action: 'updated',
                url: 'https://linear.app/acme/issue/ENG-13/edited',
                reference: 'ENG-13',
                title: 'Edited',
            },
        ]);
    });

    it("keeps a Linear issue's workflow state from the result, else the requested state", () => {
        const flattened = tool(
            'm1',
            'mcp__linear__save_issue',
            JSON.stringify({ id: 'ENG-21', state: 'Done' }),
            JSON.stringify({
                id: 'ENG-21',
                title: 'Flattened',
                url: 'https://linear.app/acme/issue/ENG-21/flattened',
                status: 'In Review',
                statusType: 'started',
            }),
        );
        const nested = tool(
            'm2',
            'mcp__linear__update_issue',
            JSON.stringify({ id: 'ENG-22' }),
            JSON.stringify({
                issue: {
                    identifier: 'ENG-22',
                    url: 'https://linear.app/acme/issue/ENG-22/nested',
                    state: { name: 'Shipped', type: 'completed' },
                },
            }),
        );
        const requested = tool(
            'm3',
            'linear/save_issue',
            JSON.stringify({ id: 'ENG-23', state: 'Canceled' }),
            'Saved https://linear.app/acme/issue/ENG-23/requested',
        );
        const unknownType = tool(
            'm4',
            'mcp__linear__save_issue',
            JSON.stringify({ id: 'ENG-24' }),
            JSON.stringify({
                url: 'https://linear.app/acme/issue/ENG-24/odd',
                status: 'Parked',
                statusType: 'paused',
            }),
        );
        expect(
            collectAgentChatTrackers([flattened, nested, requested, unknownType]).map(
                ({ reference, status }) => ({ reference, status }),
            ),
        ).toEqual([
            { reference: 'ENG-21', status: { name: 'In Review', type: 'started' } },
            { reference: 'ENG-22', status: { name: 'Shipped', type: 'completed' } },
            { reference: 'ENG-23', status: { name: 'Canceled' } },
            { reference: 'ENG-24', status: { name: 'Parked' } },
        ]);
    });

    it('shows the latest Linear state when a turn moves the same issue twice', () => {
        const output = (status: string, statusType: string) =>
            JSON.stringify({
                url: 'https://linear.app/acme/issue/ENG-30/moved',
                status,
                statusType,
            });
        const started = tool(
            'm1',
            'mcp__linear__save_issue',
            '{}',
            output('In Progress', 'started'),
        );
        const done = tool(
            'm2',
            'mcp__linear__save_issue',
            JSON.stringify({ id: 'ENG-30' }),
            output('Done', 'completed'),
        );
        expect(collectAgentChatTrackers([started, done])).toMatchObject([
            { action: 'created', status: { name: 'Done', type: 'completed' } },
        ]);
    });

    it('reads pull requests and issues written through gh api, and ignores reads and sub-resources', () => {
        const created = JSON.stringify({
            html_url: 'https://github.com/acme/widgets/issues/9',
            title: 'Crash on save',
            body: 'Saving twice crashes.\nSee https://github.com/acme/widgets/pull/3',
        });
        expect(
            collectAgentChatTrackers([
                command(
                    'c1',
                    'cd widgets && gh api -X PATCH repos/acme/widgets/pulls/42 -F body=@/tmp/body.md --jq .html_url',
                    'https://github.com/acme/widgets/pull/42\n',
                ),
                command(
                    'c2',
                    "gh api /repos/acme/widgets/issues -f title='Crash on save' -f body=@notes.md",
                    created,
                ),
                command(
                    'c3',
                    "rtk gh api --method PATCH repos/acme/widgets/issues/7 -f title='Renamed' --silent",
                    '',
                ),
                command(
                    'c4',
                    'gh api repos/acme/widgets/pulls/42 --jq .html_url',
                    'https://github.com/acme/widgets/pull/42',
                ),
                command(
                    'c5',
                    "gh api repos/acme/widgets/issues/42/comments -f body='Done'",
                    'https://github.com/acme/widgets/pull/42#issuecomment-1',
                ),
                command(
                    'c6',
                    'gh api -X PATCH repos/acme/widgets/pulls/43 -f state=closed',
                    'HTTP 422',
                    'failed',
                ),
            ]),
        ).toEqual([
            {
                provider: 'github',
                kind: 'pull',
                action: 'updated',
                url: 'https://github.com/acme/widgets/pull/42',
                reference: 'acme/widgets#42',
            },
            {
                provider: 'github',
                kind: 'issue',
                action: 'created',
                url: 'https://github.com/acme/widgets/issues/9',
                reference: 'acme/widgets#9',
                title: 'Crash on save',
                excerpt: 'Saving twice crashes.',
            },
            {
                provider: 'github',
                kind: 'issue',
                action: 'updated',
                url: 'https://github.com/acme/widgets/issues/7',
                reference: 'acme/widgets#7',
                title: 'Renamed',
            },
        ]);
    });

    it('merges a create and a later edit of the same pull request into one created card', () => {
        const url = 'https://github.com/acme/widgets/pull/9';
        expect(
            collectAgentChatTrackers([
                command('c1', 'gh pr create --title First', url),
                command('c2', 'gh pr edit 9 --title Second', url),
            ]),
        ).toMatchObject([{ action: 'created', title: 'Second', url }]);
    });

    it('reads a published acceptance report from lh ingest JSON and plain output', () => {
        const id = '76b1c38d-b4bd-43b6-9a30-bc7b009c1bc1';
        const json = JSON.stringify(
            {
                acceptanceId: id,
                acceptanceUrl: `https://app.lobehub.com/acceptance/${id}`,
                cases: 4,
                roundIndex: 1,
                roundUrl: `https://app.lobehub.com/acceptance/${id}?r=1`,
            },
            null,
            2,
        );
        expect(
            collectAgentChatTrackers([
                command(
                    'c1',
                    `lh acceptance run ingest "$ROUND_DIR" --source agent-testing --requirement "$FROZEN_REQUIREMENT" --json`,
                    json,
                ),
            ]),
        ).toEqual([
            {
                provider: 'lobehub',
                kind: 'acceptance',
                action: 'created',
                url: `https://app.lobehub.com/acceptance/${id}`,
                reference: id.slice(0, 8),
                round: 1,
                checks: 4,
            },
        ]);
        expect(
            collectAgentChatTrackers([
                command(
                    'c2',
                    `lh acceptance run ingest round-2 --acceptance ${id} --title 'Bulk select'`,
                    `Ingesting .records/acceptance/bulk-select-20260908/round-2\nIngested round\n/acceptance/${id}\n.records/acceptance/bulk-select-20260908 done\n`,
                ),
            ]),
        ).toEqual([
            {
                provider: 'lobehub',
                kind: 'acceptance',
                action: 'updated',
                url: `https://app.lobehub.com/acceptance/${id}`,
                reference: '76b1c38d',
                title: 'Bulk select',
            },
        ]);
    });

    it('merges acceptance rounds of one report and ignores failed or quoted ingests', () => {
        const id = '76b1c38d-b4bd-43b6-9a30-bc7b009c1bc1';
        const round = (index: number) =>
            JSON.stringify({
                acceptanceUrl: `https://app.lobehub.com/acceptance/${id}`,
                cases: 2,
                roundIndex: index,
            });
        const items = [
            command(
                'c1',
                'lh acceptance run ingest r1 --requirement "Show cards" --json',
                round(1),
            ),
            command('c2', `lh acceptance run ingest r2 --acceptance ${id} --json`, round(2)),
            command('c3', 'lh acceptance run ingest r3 --json', round(3), 'failed'),
            command('c4', `echo "lh acceptance run ingest"`, `/acceptance/${id}`),
        ];
        expect(collectAgentChatTrackers(items)).toEqual([
            {
                provider: 'lobehub',
                kind: 'acceptance',
                action: 'created',
                url: `https://app.lobehub.com/acceptance/${id}`,
                reference: id.slice(0, 8),
                round: 2,
                title: 'Show cards',
                checks: 2,
            },
        ]);
    });

    it('names an acceptance round and check count in English for the phone', () => {
        const artifact = {
            provider: 'lobehub',
            kind: 'acceptance',
            action: 'created',
            url: 'https://app.lobehub.com/acceptance/abcdef12',
            reference: 'abcdef12',
            round: 2,
            checks: 1,
        } as const;
        expect(trackerReferenceText(artifact)).toBe('Round 2');
        expect(trackerExcerptText(artifact)).toBe('1 check');
        expect(trackerExcerptText({ ...artifact, checks: 3 })).toBe('3 checks');
        expect(trackerReferenceText({ ...artifact, round: undefined })).toBe('abcdef12');
    });
});
