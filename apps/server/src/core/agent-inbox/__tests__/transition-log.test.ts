import { Buffer } from 'node:buffer';

import { AGENT_MESSAGE_APPROVAL_TTL_MS } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it } from 'vitest';

import {
    MAX_PAIR_MESSAGES_PER_WINDOW,
    MAX_PENDING_BYTES,
    MAX_REPLY_DEPTH,
    MAX_WAITING_PER_ENDPOINT,
} from '../rules';
import { sendInput, setup } from './inbox.fixture';

type Fields = Record<string, string | number | boolean | null>;

const FIELD_KEYS = [
    'durationMs',
    'fromEndpointId',
    'hasReplyTo',
    'messageId',
    'previousStatus',
    'queueDepth',
    'reason',
    'replyDepth',
    'status',
    'toEndpointId',
];

/**
 * An inbox whose logger keeps every `agent_message.transitioned` record's fields.
 */
function loggedSetup() {
    const records: Fields[] = [];
    const logger: Pick<StructuredLogger, 'write'> = {
        write: (_level, event, options) => {
            if (event === 'agent_message.transitioned') records.push(options?.fields ?? {});
        },
    };
    const inbox = setup({ logger });
    const transitions = () =>
        records.map(({ previousStatus, status, reason }) => [previousStatus, status, reason]);
    return { ...inbox, records, transitions };
}

function holdAll(
    inbox: ReturnType<typeof setup>['inbox'],
    context: Parameters<typeof inbox.setPolicy>[0],
) {
    inbox.setPolicy(context, { policy: 'hold', heldRetention: 'approval-window' });
}

describe('Peer Inbox transition log', () => {
    it('logs admission and a pulled delivery once each, with only content-free fields', async () => {
        const { begin, inbox, records, transitions, advance } = loggedSetup();
        const sender = begin();
        const receiver = begin();
        const body = 'privacy-sentinel peer text';
        const receipt = inbox.send(
            sender.context,
            sendInput(receiver.result.ref, body),
            'request-1',
        );
        // An idempotent retry and a duplicate within the window return the receipt without a new record.
        inbox.send(sender.context, sendInput(receiver.result.ref, body), 'request-1');
        inbox.send(sender.context, sendInput(receiver.result.ref, body), 'request-2');
        advance(250);
        await inbox.wait(receiver.context, 1_000, 'wait-1');
        inbox.confirmWait('wait-1', receiver.context);

        expect(transitions()).toEqual([
            [null, 'waiting', 'admitted'],
            ['waiting', 'delivered', 'pulled'],
        ]);
        expect(records[0]).toMatchObject({
            messageId: receipt.messageId,
            durationMs: 0,
            queueDepth: 1,
            replyDepth: 0,
            hasReplyTo: false,
            fromEndpointId: sender.result.ref.endpointId,
            toEndpointId: receiver.result.ref.endpointId,
        });
        expect(records[1]).toMatchObject({ durationMs: 250, queueDepth: 0 });
        for (const record of records) {
            expect(
                Object.keys(record).toSorted((left, right) => left.localeCompare(right)),
            ).toEqual(FIELD_KEYS);
            expect(JSON.stringify(record)).not.toContain('privacy-sentinel');
        }
    });

    it('tells an approval-window expiry from a queue TTL expiry', () => {
        const { begin, inbox, transitions, advance } = loggedSetup();
        const sender = begin();
        const held = begin();
        const waiting = begin();
        holdAll(inbox, held.context);
        inbox.send(sender.context, sendInput(held.result.ref, 'held'), 'request-1');
        inbox.send(
            sender.context,
            { ...sendInput(waiting.result.ref, 'short'), ttlMs: 1_000 },
            'request-2',
        );
        advance(AGENT_MESSAGE_APPROVAL_TTL_MS + 1);
        inbox.listHeld();

        expect(transitions()).toEqual([
            [null, 'held', 'admitted'],
            [null, 'waiting', 'admitted'],
            ['held', 'expired', 'held_expired'],
            ['waiting', 'expired', 'ttl_elapsed'],
        ]);
    });

    it('tells a policy refusal from a user denial, and logs an approval', () => {
        const { begin, inbox, transitions } = loggedSetup();
        const sender = begin();
        const refusing = begin();
        const holding = begin();
        inbox.setPolicy(refusing.context, { policy: 'refuse', heldRetention: 'approval-window' });
        holdAll(inbox, holding.context);
        inbox.send(sender.context, sendInput(refusing.result.ref, 'no'), 'request-1');
        const denied = inbox.send(
            sender.context,
            sendInput(holding.result.ref, 'deny me'),
            'request-2',
        );
        const approved = inbox.send(
            sender.context,
            sendInput(holding.result.ref, 'approve me'),
            'request-3',
        );
        inbox.deny(denied.messageId);
        inbox.approve(approved.messageId);

        expect(transitions()).toEqual([
            [null, 'refused', 'policy_refused'],
            [null, 'held', 'admitted'],
            [null, 'held', 'admitted'],
            ['held', 'refused', 'user_denied'],
            ['held', 'waiting', 'user_approved'],
        ]);
    });

    it('names a retired endpoint and disabled delivery', () => {
        const { begin, endpoints, inbox, transitions } = loggedSetup();
        const sender = begin();
        const retiring = begin();
        const disabling = begin();
        inbox.send(sender.context, sendInput(retiring.result.ref, 'one'), 'request-1');
        inbox.send(sender.context, sendInput(disabling.result.ref, 'two'), 'request-2');
        endpoints.retireTerminal('terminal-2');
        endpoints.updateMessaging({
            ref: disabling.result.ref,
            launchId: 'launch-3',
            messaging: {
                deliveryMode: 'unavailable',
                health: 'disabled',
                reason: 'integration_disabled',
                checkedAt: 2,
                nextAction: 'enable_integration',
            },
        });

        expect(transitions().slice(2)).toEqual([
            ['waiting', 'expired', 'endpoint_retired'],
            ['waiting', 'unavailable', 'delivery_disabled'],
        ]);
    });

    it('names an unresolvable target and one in another Project', () => {
        const { begin, endpoints, inbox, transitions } = loggedSetup();
        const sender = begin();
        const gone = begin();
        const elsewhere = begin({ projectId: 'project-2' });
        endpoints.retireTerminal('terminal-2');
        inbox.send(sender.context, sendInput(gone.result.ref, 'one'), 'request-1');
        inbox.send(sender.context, sendInput(elsewhere.result.ref, 'two'), 'request-2');

        expect(transitions()).toEqual([
            [null, 'unavailable', 'target_unavailable'],
            [null, 'unavailable', 'cross_project'],
        ]);
    });

    it('names each capacity limit', async () => {
        const { begin, inbox, records, transitions } = loggedSetup();
        const sender = begin();
        const receiver = begin();
        for (let index = 0; index < MAX_PAIR_MESSAGES_PER_WINDOW + 1; index += 1)
            inbox.send(
                sender.context,
                sendInput(receiver.result.ref, `pair ${index}`),
                `pair-${index}`,
            );
        expect(transitions().at(-1)).toEqual([null, 'capacity', 'pair_rate_limited']);

        const crowded = begin();
        for (let index = 0; index < MAX_WAITING_PER_ENDPOINT + 1; index += 1) {
            const from = begin();
            inbox.send(from.context, sendInput(crowded.result.ref, 'fill'), `fill-${index}`);
        }
        expect(transitions().at(-1)).toEqual([null, 'capacity', 'queue_full']);
        expect(records.at(-1)?.queueDepth).toBe(MAX_WAITING_PER_ENDPOINT);

        // A reply chain one past the limit: each side pulls and replies to the other's last message.
        const left = begin();
        const right = begin();
        let parent = inbox.send(left.context, sendInput(right.result.ref, 'start'), 'chain-0');
        let sides = [left, right];
        for (let depth = 1; depth <= MAX_REPLY_DEPTH + 1; depth += 1) {
            const [, to] = sides;
            // eslint-disable-next-line no-await-in-loop
            await inbox.wait(to.context, 1_000, `chain-wait-${depth}`);
            inbox.confirmWait(`chain-wait-${depth}`, to.context);
            parent = inbox.reply(
                to.context,
                { ...sendInput(sides[0].result.ref, `reply ${depth}`), replyTo: parent.messageId },
                `chain-${depth}`,
            );
            sides = [sides[1], sides[0]];
        }
        expect(parent.status).toBe('capacity');
        expect(transitions().at(-1)).toEqual([null, 'capacity', 'reply_depth_exceeded']);
        expect(records.at(-1)).toMatchObject({ replyDepth: MAX_REPLY_DEPTH + 1, hasReplyTo: true });
    });

    it('names the Server-wide pending budget apart from a full receiver queue', () => {
        const { begin, inbox, transitions } = loggedSetup();
        const receivers = Array.from({ length: 6 }, () => begin());
        const body = 'x'.repeat(16 * 1024);
        const fits = MAX_PENDING_BYTES / Buffer.byteLength(body);
        for (let index = 0; index <= fits; index += 1) {
            const receiver = receivers[index % receivers.length];
            inbox.send(begin().context, sendInput(receiver.result.ref, body), `fill-${index}`);
        }
        expect(transitions().at(-2)).toEqual([null, 'waiting', 'admitted']);
        expect(transitions().at(-1)).toEqual([null, 'capacity', 'pending_limit_reached']);
    });

    it('returns the same receipts when the logger throws', () => {
        const { begin, inbox } = setup({
            logger: {
                write: () => {
                    throw new Error('disk full');
                },
            },
        });
        const sender = begin();
        const receiver = begin();
        holdAll(inbox, receiver.context);
        const receipt = inbox.send(
            sender.context,
            sendInput(receiver.result.ref, 'hi'),
            'request-1',
        );
        expect(receipt.status).toBe('held');
        expect(inbox.approve(receipt.messageId).status).toBe('waiting');
    });
});
