import type { ObservationContext, StructuredLogger } from '@caxri/system';
import {
    currentObservationContext,
    mergeObservationContext,
    runWithObservationContext,
} from '@caxri/system';
import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

interface CapturedRecord {
    event: string;
    context: ObservationContext;
    fields: Record<string, unknown>;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Records what the real logger would stamp on each write: the ambient observation context merged with the explicit one.
 */
function captureRecords(logWrite: Fixture['logWrite']): CapturedRecord[] {
    const records: CapturedRecord[] = [];
    logWrite.mockImplementation((...[, event, options]: Parameters<StructuredLogger['write']>) => {
        records.push({
            event,
            context: mergeObservationContext(currentObservationContext(), options?.context),
            fields: options?.fields ?? {},
        });
    });
    return records;
}

function inRequest<T>(requestId: string, action: () => T): T {
    return runWithObservationContext(
        { requestId, traceId: requestId, clientId: 'client-1', projectId: 'project-1' },
        action,
    );
}

function eventsNamed(records: CapturedRecord[], event: string): CapturedRecord[] {
    return records.filter((record) => record.event === event);
}

describe('AgentChatService observability', () => {
    it('stamps one Agent Run on a provider process and points each finished turn at the request that started it', async () => {
        const context = await fixture();
        const { service, terminal, until } = context;
        const records = captureRecords(context.logWrite);
        await until((snapshot) => snapshot.status === 'ready');

        for (const [index, requestId] of ['send-1', 'send-2'].entries()) {
            // eslint-disable-next-line no-await-in-loop
            await inRequest(requestId, () => service.send(terminal.id, { text: 'hi there' }));
            // eslint-disable-next-line no-await-in-loop
            await until(
                (snapshot) =>
                    snapshot.turns.filter((turn) => turn.status === 'completed').length ===
                    index + 1,
            );
        }
        await inRequest('restart-1', () => service.restart(terminal.id));
        await inRequest('send-3', () => service.send(terminal.id, { text: 'after restart' }));
        await until(
            (snapshot) => snapshot.turns.filter((turn) => turn.status === 'completed').length === 3,
        );

        const started = eventsNamed(records, 'agent_chat.process_started');
        const finished = eventsNamed(records, 'agent_chat.turn_finished');
        expect(finished).toHaveLength(3);
        const [firstRun, secondRun] = finished.map((record) => record.context.agentRunId);
        expect(firstRun).toBeTruthy();
        expect(finished[1].context.agentRunId).toBe(firstRun);
        expect(finished[2].context.agentRunId).not.toBe(firstRun);
        expect(started.at(-1)?.context).toMatchObject({
            agentRunId: finished[2].context.agentRunId,
            requestId: 'restart-1',
        });
        expect(secondRun).toBe(firstRun);
        expect(finished.map((record) => record.fields.startRequestId)).toEqual([
            'send-1',
            'send-2',
            'send-3',
        ]);
        for (const record of finished) {
            expect(record.fields.turnId).toEqual(expect.any(String));
            expect(record.context).toMatchObject({
                terminalId: terminal.id,
                sessionId: terminal.sessionId,
                traceId: record.context.agentRunId,
            });
            expect(record.context).not.toHaveProperty('requestId');
            expect(record.context).not.toHaveProperty('clientId');
            expect(record.context).not.toHaveProperty('projectId');
        }
        // The exit the restart caused is written from the first process's callbacks, so it carries that Agent Run.
        expect(eventsNamed(records, 'agent_chat.process_exited')[0]?.context.agentRunId).toBe(
            firstRun,
        );
    });

    it('records no start request for a turn the queue dispatched', async () => {
        const context = await fixture();
        const { service, terminal, until } = context;
        const records = captureRecords(context.logWrite);
        await inRequest('send-1', () => service.send(terminal.id, { text: 'please approve this' }));
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        await inRequest('send-2', () => service.send(terminal.id, { text: 'queued after it' }));
        service.respond(terminal.id, pending.requests[0].id, {
            kind: 'decision',
            decision: 'accept',
        });
        await until(
            (snapshot) => snapshot.turns.filter((turn) => turn.status === 'completed').length === 2,
        );

        expect(
            eventsNamed(records, 'agent_chat.turn_finished').map(
                (record) => record.fields.startRequestId,
            ),
        ).toEqual(['send-1', null]);
    });
});
