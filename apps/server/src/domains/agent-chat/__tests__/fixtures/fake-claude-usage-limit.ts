import crypto from 'node:crypto';

import type { FakeClaudeIo } from './fake-claude-io';

const HOUR_SECONDS = 3_600;

/**
 * Plan-limit and request-failure scenarios, as Claude Code reports them: `connection dropped` and `unreported limit`
 * fail the turn with Claude Code's synthetic error reply and an error result but no known plan limit, `usage exhausted`
 * fails the turn on a used-up 5-hour limit (a `rejected` `rate_limit_event`, then the synthetic "You've hit your
 * session limit" reply and an error result), and `weekly nearly used` answers normally after a warning that the weekly
 * limit is at 99.5%, and `weekly guard` warns the same while a long reply is still streaming, so the usage guard stops
 * it (the window resets in 2 hours, or in 48 with `far`). Returns whether the turn was one of them.
 */
export async function didRunUsageLimitScenario(
    io: FakeClaudeIo,
    startedAt: number,
    text: string,
): Promise<boolean> {
    if (text.includes('connection dropped') || text.includes('unreported limit')) {
        // `unreported limit` is a used-up limit whose `rate_limit_event` this session never saw, as after a resume.
        const [error, reply] = text.includes('connection dropped')
            ? [
                  'server_error',
                  'API Error: Connection dropped (ECONNRESET). Check the proxy set in https_proxy, then try again.',
              ]
            : ['rate_limit', "You've hit your weekly limit · resets 2pm (Asia/Shanghai)"];
        sendSyntheticError(io, error, reply);
        io.result(startedAt, reply, true);
        return true;
    }
    const now = Math.floor(Date.now() / 1000);
    if (text.includes('usage exhausted')) {
        io.send(
            io.frame({
                type: 'rate_limit_event',
                rate_limit_info: {
                    status: 'rejected',
                    rateLimitType: 'five_hour',
                    resetsAt: now + 2 * HOUR_SECONDS,
                    utilization: 1,
                    overageStatus: 'rejected',
                },
            }),
        );
        const reply = "You've hit your session limit · resets 5pm";
        sendSyntheticError(io, 'rate_limit', reply);
        io.result(startedAt, reply, true);
        return true;
    }
    if (text.includes('weekly guard')) {
        io.send(
            io.frame({
                type: 'rate_limit_event',
                rate_limit_info: {
                    status: 'allowed_warning',
                    rateLimitType: 'seven_day',
                    resetsAt: now + (text.includes('far') ? 48 : 2) * HOUR_SECONDS,
                    utilization: 0.995,
                },
            }),
        );
        const isComplete = await io.didStreamFully('word '.repeat(300), 50);
        io.result(startedAt, isComplete ? 'done' : 'interrupted', !isComplete);
        return true;
    }
    if (!text.includes('weekly nearly used')) return false;
    io.send(
        io.frame({
            type: 'rate_limit_event',
            rate_limit_info: {
                status: 'allowed_warning',
                rateLimitType: 'seven_day',
                resetsAt: now + 48 * HOUR_SECONDS,
                utilization: 0.995,
            },
        }),
    );
    await io.didStreamFully('Almost out of weekly usage.', 0);
    io.result(startedAt, 'done');
    return true;
}

/**
 * Claude Code's local reply to a failed request: an assistant message from the `<synthetic>` model, with the failure's
 * category in `error` and its text as the content.
 */
function sendSyntheticError(io: FakeClaudeIo, error: string, text: string): void {
    io.send(
        io.frame({
            type: 'assistant',
            error,
            message: {
                id: `msg_${crypto.randomUUID()}`,
                type: 'message',
                role: 'assistant',
                model: '<synthetic>',
                content: [{ type: 'text', text }],
                stop_reason: 'stop_sequence',
                usage: { input_tokens: 0, output_tokens: 0 },
            },
        }),
    );
}
