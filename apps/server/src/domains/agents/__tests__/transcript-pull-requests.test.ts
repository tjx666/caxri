import { describe, expect, it } from 'vitest';

import {
    createTranscriptPullRequestScan,
    lastPullRequestReference,
    resetTranscriptPullRequestScan,
    scanTranscriptPullRequestLine,
} from '../transcript-pull-requests';

function assistantToolUse(id: string, command: string): string {
    return JSON.stringify({
        type: 'assistant',
        message: {
            content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
        },
    });
}

function toolResult(toolUseId: string, content: unknown): string {
    return JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    });
}

function assistantText(text: string): string {
    return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

describe('transcript pull request scan', () => {
    it('binds the Session to the PR returned by its own gh pr create', () => {
        const scan = createTranscriptPullRequestScan();
        scanTranscriptPullRequestLine(
            assistantToolUse('toolu_1', 'gh pr create --title "feat: x" --body "..."'),
            scan,
        );
        scanTranscriptPullRequestLine(
            toolResult(
                'toolu_1',
                'Warning: 1 uncommitted change\nhttps://github.com/lobehub-biz/lobehub-cloud/pull/1319',
            ),
            scan,
        );
        expect(scan.created).toEqual({
            owner: 'lobehub-biz',
            repo: 'lobehub-cloud',
            number: 1319,
            url: 'https://github.com/lobehub-biz/lobehub-cloud/pull/1319',
        });
        expect(scan.pendingCreateToolUseIds.size).toBe(0);
    });

    it('prefers a created PR over a later mention, and a mention over nothing', () => {
        const scan = createTranscriptPullRequestScan();
        scanTranscriptPullRequestLine(
            assistantText('Similar to https://github.com/lobehub/lobehub/pull/1 from last week.'),
            scan,
        );
        expect(scan.created).toBeUndefined();
        expect(scan.mentioned?.number).toBe(1);

        scanTranscriptPullRequestLine(assistantToolUse('toolu_2', 'gh pr create -f'), scan);
        scanTranscriptPullRequestLine(
            toolResult('toolu_2', [
                { type: 'text', text: 'https://github.com/lobehub/lobehub/pull/19024\n' },
            ]),
            scan,
        );
        scanTranscriptPullRequestLine(
            assistantText('Also see https://github.com/lobehub/lobehub/pull/2.'),
            scan,
        );
        expect(scan.created?.number).toBe(19024);
        expect(scan.mentioned?.number).toBe(2);
    });

    it('ignores user prompts and unrelated tool results', () => {
        const scan = createTranscriptPullRequestScan();
        scanTranscriptPullRequestLine(
            JSON.stringify({
                type: 'user',
                message: {
                    content: [
                        { type: 'text', text: 'look at https://github.com/lobehub/lobehub/pull/5' },
                    ],
                },
            }),
            scan,
        );
        scanTranscriptPullRequestLine(assistantToolUse('toolu_3', 'gh pr view 7 --json url'), scan);
        scanTranscriptPullRequestLine(
            toolResult('toolu_3', '{"url":"https://github.com/lobehub/lobehub/pull/7"}'),
            scan,
        );
        scanTranscriptPullRequestLine('not json {', scan);
        expect(scan.created ?? scan.mentioned).toBeUndefined();
    });

    it('resets harvested links when the transcript is rewritten', () => {
        const scan = createTranscriptPullRequestScan();
        scanTranscriptPullRequestLine(
            assistantText('https://github.com/lobehub/lobehub/pull/9'),
            scan,
        );
        resetTranscriptPullRequestScan(scan);
        expect(scan.created ?? scan.mentioned).toBeUndefined();
    });

    it('extracts the last well-formed PR link from text', () => {
        expect(
            lastPullRequestReference(
                'a https://github.com/o/r/pull/1/files then https://github.com/o/r/pull/2)',
            ),
        ).toMatchObject({ number: 2 });
        expect(lastPullRequestReference('https://github.com/o/r/issues/3')).toBeUndefined();
    });
});
