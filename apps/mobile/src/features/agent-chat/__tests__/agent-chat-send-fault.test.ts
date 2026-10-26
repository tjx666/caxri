import { describe, expect, it } from 'vitest';

import {
    CHAT_SEND_UNKNOWN_FAULT,
    createChatSendFaultGate,
    isChatSendUnknownFault,
} from '../agent-chat-send-fault';

describe('Chat send Acceptance fault', () => {
    it('activates only for the exact fault value', () => {
        expect(isChatSendUnknownFault(CHAT_SEND_UNKNOWN_FAULT)).toBe(true);
        for (const value of [
            undefined,
            '',
            'render-once',
            'storage-read-once',
            'chat-send-unknown',
            'CHAT-SEND-UNKNOWN-ONCE',
            ' chat-send-unknown-once',
        ])
            expect(isChatSendUnknownFault(value)).toBe(false);
    });

    it('fires once, then lets later sends through', () => {
        const gate = createChatSendFaultGate(CHAT_SEND_UNKNOWN_FAULT);
        expect(gate.shouldInject()).toBe(true);
        expect(gate.shouldInject()).toBe(false);
        expect(gate.shouldInject()).toBe(false);
    });

    it('never fires without the fault value', () => {
        expect(createChatSendFaultGate(undefined).shouldInject()).toBe(false);
        expect(createChatSendFaultGate('render-once').shouldInject()).toBe(false);
    });
});
