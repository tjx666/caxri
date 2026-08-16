import { describe, expect, it } from 'vitest';

import {
    AGENT_MESSAGE_APPROVAL_TTL_MS,
    agentInboxMethods,
    agentMessageBodySchema,
    MAX_AGENT_MESSAGE_BYTES,
} from '../agent-inbox-contract.js';

describe('agentMessageBodySchema', () => {
    it('allows tab, newline, and carriage return but rejects other control characters', () => {
        expect(agentMessageBodySchema.safeParse('line one\nline two\tindented\r').success).toBe(
            true,
        );
        expect(
            agentMessageBodySchema.safeParse(`escape${String.fromCodePoint(0x1b)}sequence`).success,
        ).toBe(false);
        expect(
            agentMessageBodySchema.safeParse(`del${String.fromCodePoint(0x7f)}byte`).success,
        ).toBe(false);
    });

    it('rejects a body whose UTF-8 byte length exceeds the peer message budget', () => {
        const multiByteCharacter = '\u{1F600}';
        const charactersNeeded = Math.floor(MAX_AGENT_MESSAGE_BYTES / 4) + 1;
        expect(
            agentMessageBodySchema.safeParse(multiByteCharacter.repeat(charactersNeeded)).success,
        ).toBe(false);
        expect(
            agentMessageBodySchema.safeParse(multiByteCharacter.repeat(charactersNeeded - 1))
                .success,
        ).toBe(true);
    });
});

describe('agent-inbox-contract send/reply params', () => {
    const to = { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 };

    it('defaults ttlMs to the approval TTL when omitted', () => {
        const parsed = agentInboxMethods['agent.message.send'].params.parse({
            to,
            body: 'plain peer text',
        });
        expect(parsed.ttlMs).toBe(AGENT_MESSAGE_APPROVAL_TTL_MS);
    });

    it('requires replyTo on the reply command but not on a fresh send', () => {
        expect(
            agentInboxMethods['agent.message.reply'].params.safeParse({
                to,
                body: 'a reply',
            }).success,
        ).toBe(false);
        expect(
            agentInboxMethods['agent.message.reply'].params.safeParse({
                to,
                body: 'a reply',
                replyTo: 'message-1',
            }).success,
        ).toBe(true);
    });

    it('defaults the pull-wait timeout for agent.message.wait', () => {
        const parsed = agentInboxMethods['agent.message.wait'].params.parse({});
        expect(parsed.timeoutMs).toBe(15_000);
    });
});
