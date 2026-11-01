import type { AgentChatItem } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readChatTranscript } from '../../chat-launch';
import type { ChatProjection } from '../../chat-projection';
import type { AgentChatServiceOptions } from '../../service-options';
import { forgetParsedTranscript, MAX_PARSED_TRANSCRIPTS, readChatHistoryPage } from '../read';

vi.mock('../../chat-launch', () => ({
    requireChatTerminal: () => ({ provider: 'claude' }),
    readChatTranscript: vi.fn(),
}));

vi.mock('../claude-history', () => ({
    claudeHistoryItems: () => ({
        items: [0, 1, 2].map((index): AgentChatItem => ({
            id: `m${index}`,
            turnId: `t${index}`,
            type: 'userMessage',
            text: `Message ${index}`,
        })),
        turns: [],
    }),
}));

const options = {} as Pick<AgentChatServiceOptions, 'agentEnvironment' | 'database'>;
const readTranscript = vi.mocked(readChatTranscript);

/**
 * A projection whose archive is exhausted, so every page falls through to the provider transcript.
 */
function exhaustedProjection(terminalId: string, historyId = 'history-1'): ChatProjection {
    return {
        snapshot: { terminalId, historyId, items: [{ id: 'm2' }] },
        history: { page: () => {}, isIncomplete: true },
    } as unknown as ChatProjection;
}

async function pageBack(terminalId: string, historyId?: string): Promise<void> {
    await readChatHistoryPage(options, exhaustedProjection(terminalId, historyId), 'm2');
}

describe('parsed transcript cache', () => {
    const terminals: string[] = [];

    beforeEach(() => {
        vi.useFakeTimers();
        readTranscript.mockReset();
        readTranscript.mockResolvedValue({ content: '', truncated: false });
    });

    afterEach(() => {
        for (const terminalId of terminals) forgetParsedTranscript(terminalId);
        terminals.length = 0;
        vi.useRealTimers();
    });

    it('reuses a parse while the Chat keeps paging', async () => {
        terminals.push('terminal-a');
        await pageBack('terminal-a');
        await pageBack('terminal-a');

        expect(readTranscript).toHaveBeenCalledTimes(1);
    });

    it('drops a closed Chat parse at once', async () => {
        terminals.push('terminal-a');
        await pageBack('terminal-a');
        forgetParsedTranscript('terminal-a');
        await pageBack('terminal-a');

        expect(readTranscript).toHaveBeenCalledTimes(2);
    });

    it('evicts the least recently paged Chat past the cap', async () => {
        const ids = Array.from({ length: MAX_PARSED_TRANSCRIPTS + 1 }, (_, index) => `t-${index}`);
        terminals.push(...ids);
        // Paged one after another so the cache's recency order is the array order.
        // eslint-disable-next-line no-await-in-loop -- sequential by design, see above
        for (const terminalId of ids) await pageBack(terminalId);
        readTranscript.mockClear();

        await pageBack(ids.at(-1)!);
        expect(readTranscript).not.toHaveBeenCalled();
        await pageBack(ids[0]);
        expect(readTranscript).toHaveBeenCalledTimes(1);
    });

    it('parses again once the TTL passes without a page', async () => {
        terminals.push('terminal-a');
        await pageBack('terminal-a');
        await vi.advanceTimersByTimeAsync(61_000);
        await pageBack('terminal-a');

        expect(readTranscript).toHaveBeenCalledTimes(2);
    });

    it('never lets an older entry expiry drop a newer parse of the same Chat', async () => {
        terminals.push('terminal-a');
        await Promise.all([pageBack('terminal-a'), pageBack('terminal-a', 'history-2')]);
        readTranscript.mockClear();

        await vi.advanceTimersByTimeAsync(30_000);
        await pageBack('terminal-a', 'history-2');
        await vi.advanceTimersByTimeAsync(40_000);
        await pageBack('terminal-a', 'history-2');

        expect(readTranscript).not.toHaveBeenCalled();
    });
});
