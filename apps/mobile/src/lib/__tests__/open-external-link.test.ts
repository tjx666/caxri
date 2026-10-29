import { describe, expect, it, vi } from 'vitest';

import { openExternalLink } from '../open-external-link';

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() } }));

describe('openExternalLink', () => {
    it('reports a link the system refuses to open', async () => {
        const report = vi.fn();
        await openExternalLink('https://example.com/issue/1', {
            open: () => Promise.reject(new Error('no handler')),
            report,
        });
        expect(report).toHaveBeenCalledWith(
            "Couldn't open link",
            'No app on this device could open https://example.com/issue/1.',
        );
    });

    it('shows a Toast by default when the system refuses the link', async () => {
        const { toastStore } = await import('../../components/toast-store');
        await openExternalLink('https://example.com/x', {
            open: () => Promise.reject(new Error('no handler')),
        });
        expect(toastStore.getSnapshot()).toMatchObject({
            message: "Couldn't open link",
            tone: 'error',
        });
        toastStore.dismiss();
    });

    it('stays quiet when the link opens', async () => {
        const report = vi.fn();
        const open = vi.fn(() => Promise.resolve(true));
        await openExternalLink('https://example.com', { open, report });
        expect(open).toHaveBeenCalledWith('https://example.com');
        expect(report).not.toHaveBeenCalled();
    });
});
