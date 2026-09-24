import { describe, expect, it } from 'vitest';

import type { MobileSessionItem } from '../session-model';
import { sessionTerminalPreviewContent } from '../session-terminal-preview-content';

const session = {
    primaryAgentTerminalId: 'terminal-1',
    primaryTerminal: { lastProcessState: 'running' },
} as MobileSessionItem;
const empty = { error: null, isLoading: false, preview: null };

describe('Terminal preview content', () => {
    it('distinguishes missing, loading, and failed preview reads', () => {
        expect(
            sessionTerminalPreviewContent({ ...session, primaryAgentTerminalId: undefined }, empty),
        ).toBe('This Session has no primary Agent output.');
        expect(sessionTerminalPreviewContent(session, { ...empty, isLoading: true })).toBe(
            'Loading the latest Agent output…',
        );
        expect(sessionTerminalPreviewContent(session, { ...empty, error: 'failed' })).toBe(
            'Latest Agent output could not be loaded.',
        );
    });

    it('keeps live content and separates unavailable from empty live output', () => {
        const preview = {
            terminalId: 'terminal-1',
            availability: 'live' as const,
            content: 'latest output',
            truncated: false,
            updatedAt: 1,
        };
        expect(sessionTerminalPreviewContent(session, { ...empty, preview })).toBe('latest output');
        expect(
            sessionTerminalPreviewContent(session, {
                ...empty,
                preview: { ...preview, content: '' },
            }),
        ).toBe('No output yet.');
        expect(
            sessionTerminalPreviewContent(session, {
                ...empty,
                preview: { ...preview, availability: 'unavailable', content: '' },
            }),
        ).toBe('Output is unavailable.');
    });
});
