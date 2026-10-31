import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { awayRecapFailureReason } from '../side-question/chat-away-recap';
import { EmptySideAnswerError } from '../side-question/side-answer-error';
import { fixture } from './chat-service-fixture';

describe('AgentChatService away recap', () => {
    it.each(['claude', 'codex'] as const)(
        'records a %s side answer as the recap of the latest reply, outside the conversation',
        async (provider) => {
            const { service, terminal, until } = await fixture({ provider });
            await service.send(terminal.id, { text: 'hello' });
            const replied = await until(
                (snapshot) => snapshot.turns.length === 1 && !snapshot.activeTurnId,
            );
            const lastResponseAt = replied.usage?.lastResponseAt;
            expect(lastResponseAt).toBeDefined();

            const text = await service.recapAway(terminal.id, lastResponseAt!);
            expect(text).toMatch(/^Side answer to "The user stepped away/);
            const snapshot = service.read(terminal.id);
            expect(snapshot.awayRecap).toMatchObject({ text, lastResponseAt });
            expect(snapshot.items.filter((item) => item.type === 'userMessage')).toHaveLength(1);
        },
    );

    it('refuses a recap for a reply the Chat has moved past', async () => {
        const { service, terminal, until } = await fixture({ provider: 'claude' });
        await service.send(terminal.id, { text: 'hello' });
        const replied = await until(
            (snapshot) => snapshot.turns.length === 1 && !snapshot.activeTurnId,
        );
        let error: unknown;
        try {
            await service.recapAway(terminal.id, replied.usage!.lastResponseAt! - 1);
        } catch (error_) {
            error = error_;
        }
        expect(awayRecapFailureReason(error)).toBe('changed');
        expect(service.read(terminal.id).awayRecap).toBeUndefined();
    });
});

describe('awayRecapFailureReason', () => {
    it('maps each failure to its closed reason', () => {
        expect(awayRecapFailureReason(new EmptySideAnswerError('recap'))).toBe('empty');
        expect(awayRecapFailureReason(new CaxriError('TIMEOUT', 'slow'))).toBe('timeout');
        expect(awayRecapFailureReason(new CaxriError('USAGE_LIMITED', 'limit'))).toBe('usageGuard');
        expect(
            awayRecapFailureReason(new CaxriError('UNAVAILABLE', 'The Chat is not running')),
        ).toBe('notRunning');
        expect(awayRecapFailureReason(new Error('boom'))).toBe('providerError');
    });
});
