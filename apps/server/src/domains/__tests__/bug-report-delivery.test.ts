import type { AgentChatImageInput, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createBugReportDeliveryHandler } from '../bug-report-delivery';
import type { CaxriDatabase } from '../db';

const image: AgentChatImageInput = {
    mediaType: 'image/jpeg',
    data: 'AAAA',
    thumbnail: 'data:image/jpeg;base64,AAAA',
};

function chatTerminal(provider: TerminalRecord['provider']): TerminalRecord {
    return {
        id: 'terminal-1',
        provider,
        sessionId: 'session-1',
        surface: 'chat',
    } as TerminalRecord;
}

function deliver(terminal: TerminalRecord, images?: AgentChatImageInput[]) {
    const send = vi.fn(() => Promise.resolve());
    const write = vi.fn(() => true);
    const handlers = createBugReportDeliveryHandler({
        agentChat: { send },
        database: { getTerminal: () => terminal } as unknown as CaxriDatabase,
        terminals: { agentProcessId: () => {}, write },
    });
    const result = handlers['bugReport.deliver']({
        images,
        pasteImage: false,
        report: '# Bug report',
        sessionId: 'session-1',
        terminalId: terminal.id,
    });
    return { result, send, write };
}

describe('bug report delivery to an Agent Chat', () => {
    it('sends the report and screenshot as one Chat message without touching a PTY', async () => {
        const { result, send, write } = deliver(chatTerminal('codex'), [image]);

        await expect(result).resolves.toBeNull();
        expect(send).toHaveBeenCalledWith('terminal-1', { text: '# Bug report', images: [image] });
        expect(write).not.toHaveBeenCalled();
    });

    it('refuses a screenshot for a provider whose Chat accepts no images', () => {
        expect(() => deliver(chatTerminal('grok'), [image])).toThrow(
            expect.objectContaining({ code: 'CONFLICT' }),
        );
    });

    it('sends text only to a provider whose Chat accepts no images', async () => {
        const { result, send } = deliver(chatTerminal('grok'));

        await expect(result).resolves.toBeNull();
        expect(send).toHaveBeenCalledWith('terminal-1', {
            text: '# Bug report',
            images: undefined,
        });
    });

    it('refuses Chat images for a PTY Agent', () => {
        expect(() => deliver({ ...chatTerminal('codex'), surface: undefined }, [image])).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }),
        );
    });
});
