import { describe, expect, it, vi } from 'vitest';

import { OPEN_LINK_FAILED_TITLE, openExternalLink } from './open-external-link';

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() } }));

describe('openExternalLink', () => {
    it('reports a link the system refuses to open', async () => {
        const report = vi.fn();
        await openExternalLink('https://example.com/issue/1', {
            open: () => Promise.reject(new Error('no handler')),
            report,
        });
        expect(report).toHaveBeenCalledWith(
            OPEN_LINK_FAILED_TITLE,
            'No app on this device could open https://example.com/issue/1.',
        );
    });

    it('stays quiet when the link opens', async () => {
        const report = vi.fn();
        const open = vi.fn(() => Promise.resolve(true));
        await openExternalLink('https://example.com', { open, report });
        expect(open).toHaveBeenCalledWith('https://example.com');
        expect(report).not.toHaveBeenCalled();
    });
});
