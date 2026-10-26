import crypto from 'node:crypto';

import type { FakeClaudeIo } from './fake-claude-io';

const HOUR_SECONDS = 3_600;

/**
 * Plan-limit scenarios, as Claude Code reports them: `usage exhausted` fails the turn on a used-up 5-hour limit (a
 * `rejected` `rate_limit_event`, then the synthetic "You've hit your session limit" reply and an error result), and
 * `weekly nearly used` answers normally after a warning that the weekly limit is at 99.5%. Returns whether the turn was
 * one of them.
 */
export async function didRunUsageLimitScenario(
    io: FakeClaudeIo,
    startedAt: number,
    text: string,
): Promise<boolean> {
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
        io.send(
            io.frame({
                type: 'assistant',
                error: 'rate_limit',
                message: {
                    id: `msg_${crypto.randomUUID()}`,
                    type: 'message',
                    role: 'assistant',
                    model: '<synthetic>',
                    content: [{ type: 'text', text: reply }],
                    stop_reason: 'stop_sequence',
                    usage: { input_tokens: 0, output_tokens: 0 },
                },
            }),
        );
        io.result(startedAt, reply, true);
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
