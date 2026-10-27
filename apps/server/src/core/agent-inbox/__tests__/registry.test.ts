import { agentMessageBodySchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { decideInboundStatus } from '..';
import { MAX_RECEIPTS } from '../rules';
import { sendInput, setup } from './inbox.fixture';

describe('AgentInboxRegistry', () => {
    it('rejects oversized and protocol-control message bodies', () => {
        expect(agentMessageBodySchema.safeParse('plain\npeer text').success).toBe(true);
        expect(agentMessageBodySchema.safeParse(`/approve\u{1B}[2J`).success).toBe(false);
        expect(agentMessageBodySchema.safeParse('x'.repeat(16 * 1024 + 1)).success).toBe(false);
    });

    it('exhaustively applies auto, accept, hold, and refuse permission precedence', () => {
        const classes = ['standard', 'elevated', 'unknown'] as const;
        for (const sender of classes) {
            for (const receiver of classes) {
                expect(decideInboundStatus('accept', sender, receiver)).toBe('waiting');
                expect(decideInboundStatus('hold', sender, receiver)).toBe('held');
                expect(decideInboundStatus('refuse', sender, receiver)).toBe('refused');
                expect(decideInboundStatus('auto', sender, receiver)).toBe(
                    sender !== 'unknown' && sender === receiver ? 'waiting' : 'held',
                );
            }
        }
    });

    it('reports delivered only after flush confirmation and requeues an abandoned reservation', async () => {
        const { begin, inbox, receiptEvents } = setup();
        const sender = begin();
        const receiver = begin();
        const body = 'privacy-sentinel peer text';
        const receipt = inbox.send(
            sender.context,
            sendInput(receiver.result.ref, body),
            'request-1',
        );
        expect(receipt.status).toBe('waiting');

        const first = await inbox.wait(receiver.context, 1_000, 'wait-1');
        expect(first.message).toMatchObject({ body, origin: 'peer' });
        expect(inbox.receipt(sender.context, receipt.messageId).status).toBe('waiting');
        inbox.cancelWait('wait-1');

        const second = await inbox.wait(receiver.context, 1_000, 'wait-2');
        expect(second.message?.id).toBe(receipt.messageId);
        inbox.confirmWait('wait-2', receiver.context);
        expect(inbox.receipt(sender.context, receipt.messageId).status).toBe('delivered');
        expect(JSON.stringify(receiptEvents)).not.toContain(body);
        inbox.close();
    });

    it('checks without waiting, rejects pull on push, and fails pending text on downgrade', () => {
        const { begin, endpoints, inbox } = setup();
        const sender = begin();
        const receiver = begin();
        const receipt = inbox.send(
            sender.context,
            sendInput(receiver.result.ref, 'check once'),
            'request-check',
        );
        const checked = inbox.check(receiver.context, 'check-1');
        expect(checked).toMatchObject({ outcome: 'message', message: { id: receipt.messageId } });
        expect(inbox.receipt(sender.context, receipt.messageId).status).toBe('waiting');
        inbox.cancelWait('check-1');
        expect(inbox.check(receiver.context, 'check-2').message?.id).toBe(receipt.messageId);
        inbox.cancelWait('check-2');

        expect(
            endpoints.updateMessaging({
                ref: receiver.result.ref,
                launchId: 'launch-2',
                messaging: {
                    deliveryMode: 'unavailable',
                    health: 'disabled',
                    reason: 'integration_disabled',
                    checkedAt: 2,
                    nextAction: 'enable_integration',
                },
            }),
        ).toBe(true);
        expect(inbox.receipt(sender.context, receipt.messageId).status).toBe('unavailable');
        expect(() => inbox.check(receiver.context, 'check-disabled')).toThrow(
            expect.objectContaining({ code: 'UNAVAILABLE' }) as Error,
        );

        const push = begin({
            messaging: {
                deliveryMode: 'push',
                health: 'ready',
                reason: 'provider_channel_ready',
                checkedAt: 3,
                nextAction: 'none',
            },
        });
        expect(() => inbox.check(push.context, 'check-push')).toThrow(
            expect.objectContaining({ code: 'CONFLICT' }) as Error,
        );
        inbox.close();
    });

    it('holds mismatched classes for Desktop approval and expires them with the receiver generation', async () => {
        const { begin, endpoints, inbox } = setup();
        const sender = begin();
        const receiver = begin({ permissionClass: 'elevated' });
        const body = `${'review-visible '.repeat(30)}full-message-tail`;
        const held = inbox.send(
            sender.context,
            sendInput(receiver.result.ref, body),
            'request-held',
        );
        expect(held.status).toBe('held');
        const heldMessages = inbox.listHeld();
        expect(heldMessages).toHaveLength(1);
        expect(heldMessages[0]?.messageId).toBe(held.messageId);
        expect(typeof heldMessages[0]?.preview).toBe('string');
        expect(heldMessages[0]?.preview).not.toContain('full-message-tail');
        expect(inbox.heldDetail(held.messageId)).toMatchObject({ messageId: held.messageId, body });

        expect(inbox.approve(held.messageId).status).toBe('waiting');
        const pulled = await inbox.wait(receiver.context, 1_000, 'wait-held');
        expect(pulled.message).toMatchObject({ id: held.messageId, origin: 'peer' });
        inbox.confirmWait('wait-held', receiver.context);

        const stale = inbox.send(
            sender.context,
            sendInput(receiver.result.ref, 'expire with old generation'),
            'request-stale',
        );
        endpoints.retireTerminal('terminal-2');
        expect(inbox.receipt(sender.context, stale.messageId).status).toBe('expired');
        expect(inbox.listHeld()).toEqual([]);
        inbox.close();
    });

    it('converges repeated Desktop decisions for a message that already left held state', () => {
        const { advance, begin, inbox } = setup();
        const sender = begin();
        const receiver = begin({ permissionClass: 'elevated' });
        const held = inbox.send(
            sender.context,
            sendInput(receiver.result.ref, 'stale approval race'),
            'request-stale-approval',
        );

        const approved = inbox.approve(held.messageId);

        expect(inbox.heldDetail(held.messageId)).toBeNull();
        expect(inbox.approve(held.messageId)).toEqual(approved);
        expect(inbox.deny(held.messageId)).toEqual(approved);
        expect(() => inbox.heldDetail('never-existed')).toThrow(
            expect.objectContaining({ code: 'NOT_FOUND' }) as Error,
        );

        const expiring = inbox.send(
            sender.context,
            sendInput(receiver.result.ref, 'stale expiry race'),
            'request-stale-expiry',
        );
        advance(300_000);

        expect(inbox.heldDetail(expiring.messageId)).toBeNull();
        expect(inbox.approve(expiring.messageId)).toMatchObject({ status: 'expired' });
        expect(inbox.deny(expiring.messageId)).toMatchObject({ status: 'expired' });
        inbox.close();
    });

    it('enforces receiver policy, Project scope, and unavailable adapters without leaking a body', () => {
        const { begin, inbox, receiptEvents } = setup();
        const sender = begin();
        const receiver = begin();
        inbox.setPolicy(receiver.context, {
            policy: 'refuse',
            heldRetention: 'endpoint',
        });
        const refused = inbox.send(
            sender.context,
            sendInput(receiver.result.ref, 'secret refused body'),
            'request-refused',
        );
        expect(refused.status).toBe('refused');

        const crossProject = begin({ projectId: 'project-2' });
        const unavailable = inbox.send(
            sender.context,
            sendInput(crossProject.result.ref, 'secret unavailable body'),
            'request-unavailable',
        );
        expect(unavailable.status).toBe('unavailable');
        expect(JSON.stringify(receiptEvents)).not.toContain('secret');
        inbox.close();
    });

    it('deduplicates retries and bounds a bidirectional message loop', () => {
        const { begin, inbox } = setup();
        const sender = begin();
        const receiver = begin();
        const first = inbox.send(
            sender.context,
            { ...sendInput(receiver.result.ref, 'same body'), idempotencyKey: 'business-key' },
            'request-1',
        );
        const retried = inbox.send(
            sender.context,
            { ...sendInput(receiver.result.ref, 'same body'), idempotencyKey: 'business-key' },
            'request-2',
        );
        expect(retried.messageId).toBe(first.messageId);
        expect(() =>
            inbox.send(
                sender.context,
                {
                    ...sendInput(receiver.result.ref, 'changed body'),
                    idempotencyKey: 'business-key',
                },
                'request-3',
            ),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }) as Error);

        const statuses = Array.from(
            { length: 16 },
            (_, index) =>
                inbox.send(
                    sender.context,
                    sendInput(receiver.result.ref, `loop body ${index}`),
                    `loop-request-${index}`,
                ).status,
        );
        expect(statuses.at(-1)).toBe('capacity');
        inbox.close();
    });

    it('evicts terminal idempotency keys with their bounded receipts', () => {
        const { begin, inbox } = setup();
        const sender = begin();
        const unavailable = {
            endpointId: 'unavailable-endpoint',
            generation: 1,
            hostId: 'host-1',
        };

        for (let index = 0; index <= MAX_RECEIPTS; index += 1) {
            inbox.send(
                sender.context,
                {
                    ...sendInput(unavailable, `unique terminal receipt ${index}`),
                    idempotencyKey: `unique-key-${index}`,
                },
                `request-${index}`,
            );
        }

        const idempotency = Reflect.get(inbox, 'idempotency') as Map<string, unknown>;
        expect(idempotency).toHaveLength(MAX_RECEIPTS);
        expect(() =>
            inbox.send(
                sender.context,
                {
                    ...sendInput(unavailable, 'reused after receipt eviction'),
                    idempotencyKey: 'unique-key-0',
                },
                'reused-request',
            ),
        ).not.toThrow();
        inbox.close();
    });

    it('bounds duplicate fingerprints and releases them with receipt eviction', () => {
        const { begin, inbox } = setup();
        const sender = begin();
        const unavailable = {
            endpointId: 'unavailable-endpoint',
            generation: 1,
            hostId: 'host-1',
        };
        const duplicates = Reflect.get(inbox, 'duplicates') as Map<string, unknown>;
        const messages = Reflect.get(inbox, 'messages') as Map<string, unknown>;

        const first = inbox.send(
            sender.context,
            sendInput(unavailable, 'flood body 0'),
            'flood-request-0',
        );
        // A same-window retry under a different request ID still deduplicates by fingerprint.
        expect(
            inbox.send(sender.context, sendInput(unavailable, 'flood body 0'), 'flood-retry')
                .messageId,
        ).toBe(first.messageId);

        // Invalid targets bypass pair-traffic limits, so distinct bodies must not grow duplicate
        // state past the receipt bound within one TTL window (GitHub issue #174).
        for (let index = 1; index <= MAX_RECEIPTS + 64; index += 1) {
            inbox.send(
                sender.context,
                sendInput(unavailable, `flood body ${index}`),
                `flood-request-${index}`,
            );
        }
        expect(duplicates.size).toBeLessThanOrEqual(MAX_RECEIPTS);
        expect(duplicates.size).toBe(messages.size);

        // The evicted first receipt released its fingerprint, so a resend mints a fresh message
        // instead of returning another message's receipt.
        const resent = inbox.send(
            sender.context,
            sendInput(unavailable, 'flood body 0'),
            'flood-after-eviction',
        );
        expect(resent.messageId).not.toBe(first.messageId);
        inbox.close();
    });

    it('releases duplicate fingerprints when the involved generation retires', () => {
        const { begin, endpoints, inbox } = setup();
        const sender = begin();
        const unavailable = {
            endpointId: 'unavailable-endpoint',
            generation: 1,
            hostId: 'host-1',
        };
        const duplicates = Reflect.get(inbox, 'duplicates') as Map<string, unknown>;

        inbox.send(sender.context, sendInput(unavailable, 'retired body'), 'request-1');
        expect(duplicates.size).toBe(1);
        endpoints.retireTerminal('terminal-1');
        expect(duplicates.size).toBe(0);
        inbox.close();
    });

    it('releases terminal receipt idempotency records when the sender generation retires', () => {
        const { begin, endpoints, inbox } = setup();
        const sender = begin();
        const unavailable = {
            endpointId: 'unavailable-endpoint',
            generation: 1,
            hostId: 'host-1',
        };

        for (let index = 0; index < 3; index += 1) {
            inbox.send(
                sender.context,
                {
                    ...sendInput(unavailable, `terminal receipt ${index}`),
                    idempotencyKey: `terminal-key-${index}`,
                },
                `terminal-request-${index}`,
            );
        }

        const idempotency = Reflect.get(inbox, 'idempotency') as Map<string, unknown>;
        expect(idempotency).toHaveLength(3);
        endpoints.retireTerminal('terminal-1');
        expect(idempotency).toHaveLength(0);
        inbox.close();
    });

    it('caps accepted and held queues without dropping their FIFO prefixes', async () => {
        const acceptedSetup = setup();
        const acceptedReceiver = acceptedSetup.begin();
        const accepted = Array.from({ length: 51 }, (_, index) => {
            const sender = acceptedSetup.begin();
            return acceptedSetup.inbox.send(
                sender.context,
                sendInput(acceptedReceiver.result.ref, `accepted ${index}`),
                `accepted-request-${index}`,
            );
        });
        expect(accepted.slice(0, 50).every(({ status }) => status === 'waiting')).toBe(true);
        expect(accepted[50]?.status).toBe('capacity');
        const first = await acceptedSetup.inbox.wait(
            acceptedReceiver.context,
            1_000,
            'accepted-wait-1',
        );
        expect(first.message?.body).toBe('accepted 0');
        acceptedSetup.inbox.confirmWait('accepted-wait-1', acceptedReceiver.context);
        const second = await acceptedSetup.inbox.wait(
            acceptedReceiver.context,
            1_000,
            'accepted-wait-2',
        );
        expect(second.message?.body).toBe('accepted 1');
        acceptedSetup.inbox.close();

        const heldSetup = setup();
        const heldReceiver = heldSetup.begin({ permissionClass: 'elevated' });
        const held = Array.from({ length: 101 }, (_, index) => {
            const sender = heldSetup.begin();
            return heldSetup.inbox.send(
                sender.context,
                sendInput(heldReceiver.result.ref, `held ${index}`),
                `held-request-${index}`,
            );
        });
        expect(heldSetup.inbox.listHeld()).toHaveLength(100);
        expect(held[100]?.status).toBe('capacity');
        heldSetup.inbox.close();
    });

    it('expires held text deterministically and resolves an already-waiting receiver', async () => {
        const { advance, begin, inbox } = setup();
        const sender = begin();
        const heldReceiver = begin({ permissionClass: 'unknown' });
        const held = inbox.send(
            sender.context,
            sendInput(heldReceiver.result.ref, 'expires from memory'),
            'expiry-request',
        );
        advance(300_000);
        expect(inbox.listHeld()).toEqual([]);
        expect(inbox.receipt(sender.context, held.messageId).status).toBe('expired');

        const liveReceiver = begin();
        const waiting = inbox.wait(liveReceiver.context, 1_000, 'live-wait');
        const sent = inbox.send(
            sender.context,
            sendInput(liveReceiver.result.ref, 'arrives at waiter'),
            'live-send',
        );
        await expect(waiting).resolves.toMatchObject({ message: { id: sent.messageId } });
        inbox.cancelWait('live-wait');
        inbox.close();
    });

    it('binds replies to the delivered parent and its exact sender generation', async () => {
        const { begin, inbox } = setup();
        const first = begin();
        const second = begin();
        const initial = inbox.send(
            first.context,
            sendInput(second.result.ref, 'question'),
            'question-request',
        );
        await inbox.wait(second.context, 1_000, 'question-wait');
        inbox.confirmWait('question-wait', second.context);

        const reply = inbox.reply(
            second.context,
            {
                ...sendInput(first.result.ref, 'answer'),
                replyTo: initial.messageId,
            },
            'answer-request',
        );
        expect(reply).toMatchObject({ replyTo: initial.messageId, status: 'waiting' });
        expect(() =>
            inbox.reply(
                first.context,
                {
                    ...sendInput(second.result.ref, 'wrong direction'),
                    replyTo: initial.messageId,
                },
                'wrong-request',
            ),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }) as Error);
        inbox.close();
    });
});
