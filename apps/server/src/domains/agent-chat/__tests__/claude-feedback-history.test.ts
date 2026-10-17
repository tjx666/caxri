import { describe, expect, it } from 'vitest';

import { claudeHistoryItems } from '../claude-history';

/**
 * Public-safe shapes verified with Claude Code 2.1.301, including its persisted field names.
 */
describe('Claude feedback restored from Terminal history', () => {
    it('restores blocking Hook and mod reasons in order with warning severity', () => {
        const records = ['blocked_by_hook', 'dropped_by_hook'].map((kind, index) => ({
            type: 'system',
            subtype: 'informational',
            uuid: `feedback-${index}`,
            parentUuid: index ? 'feedback-0' : null,
            content: 'Provider display text.',
            level: 'warning',
            preventContinuation: true,
            promptSubmitEnding: {
                ending: { kind, reason: 'Example input blocked.\nChoose another input.' },
                promptKept: false,
            },
        }));
        const { items } = claudeHistoryItems(
            records.map((record) => JSON.stringify(record)).join('\n'),
        );
        expect(items).toHaveLength(2);
        for (const item of items)
            expect(item).toMatchObject({
                type: 'notice',
                kind: 'warning',
                message: 'Example input blocked.\nChoose another input.',
            });
    });

    it('restores local mod command output with its source instead of dropping it', () => {
        const { items } = claudeHistoryItems(
            JSON.stringify({
                type: 'system',
                subtype: 'local_command',
                uuid: 'command-result',
                level: 'info',
                content:
                    '<local-command-stdout>example-mod: First line.\nSecond line.</local-command-stdout>',
                commandRun: { command: 'display-test', args: '', plugin: 'example-mod' },
            }),
        );
        expect(items).toEqual([
            expect.objectContaining({
                type: 'notice',
                kind: 'output',
                title: 'example-mod · /display-test',
                message: 'example-mod: First line.\nSecond line.',
            }),
        ]);
    });
});

it('does not attach a standalone warning or command to the previous completed turn', () => {
    const { items } = claudeHistoryItems(
        [
            { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Hello' } },
            {
                type: 'assistant',
                uuid: 'a1',
                parentUuid: 'u1',
                message: { id: 'a1', content: [{ type: 'text', text: 'Hello.' }] },
            },
            {
                type: 'system',
                subtype: 'informational',
                uuid: 'warning',
                parentUuid: 'a1',
                content: 'Input blocked.',
                level: 'warning',
                preventContinuation: true,
            },
        ]
            .map((record) => JSON.stringify(record))
            .join('\n'),
    );
    expect(items.at(-1)).toMatchObject({
        type: 'notice',
        kind: 'warning',
        message: 'Input blocked.',
    });
    expect(items.at(-1)?.turnId).toBeUndefined();
});

it('restores a standalone startup failure without attaching it to an earlier turn', () => {
    const { items } = claudeHistoryItems(
        `${JSON.stringify({ type: 'user', uuid: 'earlier', message: { content: 'Earlier turn' } })}\n${JSON.stringify(
            {
                parentUuid: null,
                type: 'attachment',
                uuid: 'failure',
                attachment: {
                    type: 'hook_non_blocking_error',
                    hookName: 'SessionStart:startup',
                    exitCode: 1,
                    stderr: 'Example configuration could not be read.\nCheck the test configuration file.',
                    stdout: '',
                },
            },
        )}`,
    );
    expect(items.filter((item) => item.type === 'notice')).toEqual([
        expect.objectContaining({
            type: 'notice',
            kind: 'error',
            title: 'Hook "SessionStart:startup" failed (exit code 1)',
            message: 'Example configuration could not be read.\nCheck the test configuration file.',
        }),
    ]);
    expect(items.at(-1)?.turnId).toBeUndefined();
});
