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

function codexResponseItem(payload: Record<string, unknown>): string {
    return JSON.stringify({
        timestamp: '2026-05-25T16:50:51.612Z',
        type: 'response_item',
        payload,
    });
}

function codexExecCommand(callId: string, command: string): string {
    return codexResponseItem({
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: command, workdir: '/project', yield_time_ms: 10_000 }),
        call_id: callId,
    });
}

function codexCommandOutput(callId: string, output: string): string {
    return codexResponseItem({
        type: 'function_call_output',
        call_id: callId,
        output: `Chunk ID: b50e7a\nProcess exited with code 0\nOutput:\n${output}`,
    });
}

function codexAssistantText(text: string): string {
    return codexResponseItem({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
    });
}

describe('codex transcript pull request scan', () => {
    it('binds the Session to the PR returned by its own exec_command gh pr create', () => {
        const scan = createTranscriptPullRequestScan();
        scanTranscriptPullRequestLine(
            codexExecCommand(
                'call_1',
                'git push -u origin feat/x && gh pr create --base main --title "fix: x" --body-file - <<\'EOF\'\nbody\nEOF',
            ),
            scan,
        );
        scanTranscriptPullRequestLine(
            codexCommandOutput(
                'call_1',
                'remote: Create a pull request for feat/x on GitHub by visiting:\nremote: https://github.com/lobehub-biz/lobehub-cloud/pull/new/feat/x\nhttps://github.com/lobehub-biz/lobehub-cloud/pull/881\n',
            ),
            scan,
        );
        expect(scan.created).toEqual({
            owner: 'lobehub-biz',
            repo: 'lobehub-cloud',
            number: 881,
            url: 'https://github.com/lobehub-biz/lobehub-cloud/pull/881',
        });
        expect(scan.pendingCreateToolUseIds.size).toBe(0);
    });

    it('accepts the exec script tool with global gh flags and block-shaped outputs', () => {
        const scan = createTranscriptPullRequestScan();
        scanTranscriptPullRequestLine(
            codexResponseItem({
                type: 'custom_tool_call',
                name: 'exec',
                input: 'const r = await tools.exec_command({ cmd: "gh -R lobehub/lobehub pr create --base main --fill" });',
                call_id: 'call_custom',
            }),
            scan,
        );
        scanTranscriptPullRequestLine(
            codexResponseItem({
                type: 'function_call_output',
                call_id: 'call_other',
                output: 'https://github.com/lobehub/lobehub/pull/1',
            }),
            scan,
        );
        expect(scan.created).toBe(undefined);
        scanTranscriptPullRequestLine(
            codexResponseItem({
                type: 'custom_tool_call_output',
                call_id: 'call_custom',
                output: [
                    {
                        type: 'input_text',
                        text: 'Script completed\nhttps://github.com/lobehub/lobehub/pull/2\n',
                    },
                ],
            }),
            scan,
        );
        expect(scan.created?.number).toBe(2);
    });

    it('takes assistant prose as a mention but never user input or the duplicate event_msg', () => {
        const scan = createTranscriptPullRequestScan();
        scanTranscriptPullRequestLine(
            codexResponseItem({
                type: 'message',
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: 'look at https://github.com/lobehub/lobehub/pull/5',
                    },
                ],
            }),
            scan,
        );
        scanTranscriptPullRequestLine(
            JSON.stringify({
                type: 'event_msg',
                payload: {
                    type: 'agent_message',
                    message: 'https://github.com/lobehub/lobehub/pull/6',
                },
            }),
            scan,
        );
        expect(scan.mentioned).toBe(undefined);
        scanTranscriptPullRequestLine(
            codexAssistantText(
                'Opened [PR #263](https://github.com/lobehub-biz/lobehub-cloud/pull/263).',
            ),
            scan,
        );
        expect(scan.mentioned).toEqual({
            owner: 'lobehub-biz',
            repo: 'lobehub-cloud',
            number: 263,
            url: 'https://github.com/lobehub-biz/lobehub-cloud/pull/263',
        });
    });
});

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
