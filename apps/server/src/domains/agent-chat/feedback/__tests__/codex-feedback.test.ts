import type { AgentChatPatchOperation } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { ChatProviderNotice } from '../../chat-provider';
import { applyCodexNotice } from '../codex-feedback';

/**
 * Notices and log events one Codex notification produces, the way the Chat session applies it.
 */
function notice(
    method: string,
    parameters: Record<string, unknown>,
    options: { turnId?: string; activeTurnId?: string } = {},
) {
    const operations: AgentChatPatchOperation[] = [];
    const events: ChatProviderNotice[] = [];
    applyCodexNotice(
        {
            apply: (next) => operations.push(...next),
            read: () => ({ activeTurnId: options.activeTurnId }) as never,
            onProviderNotice: (event) => events.push(event),
        },
        method,
        parameters,
        options.turnId,
    );
    return {
        items: operations.map((operation) =>
            operation.op === 'upsertItem' ? operation.item : undefined,
        ),
        events,
    };
}

/**
 * A Hook run as Codex 0.165 reports it (`HookRunSummary`).
 */
function hookRun(
    status: string,
    entries: Array<{ kind: string; text: string }>,
    eventName = 'preToolUse',
) {
    return {
        id: `${eventName}:0`,
        eventName,
        status,
        entries,
        statusMessage: 'Checking the command',
        sourcePath: '/home/user/.codex/hooks.json',
        startedAt: 1_700_000_000_000,
    };
}

describe('Codex feedback notices', () => {
    it('shows a failed Hook as an error with its reason, and a Hook that ran cleanly not at all', () => {
        const failed = notice(
            'hook/completed',
            {
                turnId: 't1',
                run: hookRun('failed', [
                    { kind: 'error', text: 'hook exited with code 1' },
                    { kind: 'context', text: 'not shown' },
                ]),
            },
            { turnId: 't1' },
        );
        expect(failed.items).toEqual([
            {
                id: 'codex-hook:t1:preToolUse:0:1700000000000:0',
                turnId: 't1',
                type: 'notice',
                kind: 'error',
                title: 'Hook "PreToolUse" failed',
                message: 'hook exited with code 1',
            },
        ]);
        expect(failed.events).toEqual([
            { source: 'hook', hookEvent: 'preToolUse', hookStatus: 'failed', reason: null },
        ]);
        expect(notice('hook/completed', { run: hookRun('failed', []) }).items[0]).toMatchObject({
            message: 'No failure details were provided.',
        });

        for (const status of ['completed', 'running']) {
            expect(
                notice('hook/completed', {
                    run: hookRun(status, [{ kind: 'context', text: 'ok' }]),
                }),
            ).toEqual({
                items: [],
                events: [],
            });
        }
        expect(notice('hook/started', { run: hookRun('running', []) })).toEqual({
            items: [],
            events: [],
        });
    });

    it('shows a blocking or stopping Hook as a warning with its complete feedback', () => {
        const blocked = notice(
            'hook/completed',
            {
                run: hookRun('blocked', [
                    {
                        kind: 'feedback',
                        text: 'Force pushes are not allowed.\nOpen a pull request.',
                    },
                ]),
            },
            { turnId: 't1' },
        );
        expect(blocked.items[0]).toMatchObject({
            kind: 'warning',
            title: 'Hook "PreToolUse" blocked the action',
            message: 'Force pushes are not allowed.\nOpen a pull request.',
        });
        expect(
            notice('hook/completed', {
                run: hookRun('stopped', [{ kind: 'stop', text: 'Tests still fail.' }], 'stop'),
            }).items[0],
        ).toMatchObject({
            kind: 'warning',
            title: 'Hook "Stop" stopped the turn',
            message: 'Tests still fail.',
        });
    });

    it('splits long feedback into notices instead of cutting it', () => {
        const text = 'x'.repeat(4_500);
        const { items } = notice('hook/completed', {
            run: hookRun('failed', [{ kind: 'error', text }]),
        });
        expect(items.map((item) => (item?.type === 'notice' ? item.message?.length : 0))).toEqual([
            2_000, 2_000, 500,
        ]);
    });

    it('puts a warning in the running turn once, however often Codex repeats it', () => {
        const parameters = { message: 'Exceeded skills context budget.' };
        const first = notice('warning', parameters, { activeTurnId: 't2' });
        const again = notice('warning', parameters, { activeTurnId: 't2' });
        expect(first.items).toEqual(again.items);
        expect(first.items[0]).toMatchObject({
            turnId: 't2',
            kind: 'warning',
            title: 'Codex warning',
            message: 'Exceeded skills context budget.',
        });
        expect(first.events).toEqual([
            { source: 'warning', hookEvent: null, hookStatus: null, reason: null },
        ]);
        expect(
            notice('configWarning', {
                summary: 'Ignored key.',
                details: 'Remove it.',
                path: '/home/user/.codex/config.toml',
            }).items[0],
        ).toMatchObject({
            title: 'Codex configuration warning',
            message: 'Ignored key.\n\nRemove it.\n\n/home/user/.codex/config.toml',
        });
        expect(notice('deprecationNotice', { summary: 'Old flag.' }).items[0]).toMatchObject({
            title: 'Codex deprecation notice',
        });
        expect(notice('warning', { message: '  ' })).toEqual({ items: [], events: [] });
    });

    it('says which model answered after a reroute, and what verification Codex asks for', () => {
        const rerouted = notice(
            'model/rerouted',
            { turnId: 't1', fromModel: 'gpt-a', toModel: 'gpt-b', reason: 'highRiskCyberActivity' },
            { turnId: 't1' },
        );
        expect(rerouted.items[0]).toMatchObject({
            title: 'Model changed',
            message:
                'Codex answered with gpt-b instead of gpt-a because it detected possible high-risk cybersecurity activity.',
        });
        expect(rerouted.events[0]).toMatchObject({
            source: 'modelRerouted',
            reason: 'highRiskCyberActivity',
        });
        expect(
            notice('model/rerouted', { fromModel: 'a', toModel: 'b', reason: 'newReason' })
                .events[0],
        ).toMatchObject({ reason: 'other' });

        const verification = notice('model/verification', {
            verifications: ['trustedAccessForCyber'],
        });
        expect(verification.items[0]).toMatchObject({ title: 'Account verification needed' });
        expect(verification.events[0]).toMatchObject({ reason: 'trustedAccessForCyber' });
        expect(notice('model/verification', { verifications: ['unknown'] })).toEqual({
            items: [],
            events: [],
        });
    });

    it('never logs Hook text, and records an unknown Hook event as other', () => {
        const { events } = notice('hook/completed', {
            run: hookRun('failed', [{ kind: 'error', text: 'secret path /a/b' }], 'futureEvent'),
        });
        expect(events).toEqual([
            { source: 'hook', hookEvent: 'other', hookStatus: 'failed', reason: null },
        ]);
    });

    it('ignores notifications that are not feedback', () => {
        expect(notice('mcpServer/startupStatus/updated', { name: 'x' })).toEqual({
            items: [],
            events: [],
        });
    });
});
