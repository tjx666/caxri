import { describe, expect, it, vi } from 'vitest';

import { openLink } from '../open-link';

vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() } }));

describe('openLink', () => {
    it('shows a web page in the in-app browser', () => {
        const navigate = vi.fn();
        const openExternal = vi.fn(() => Promise.resolve());
        openLink('https://example.com/pull/1', { navigate, openExternal });
        expect(navigate).toHaveBeenCalledWith('https://example.com/pull/1');
        expect(openExternal).not.toHaveBeenCalled();
    });

    it('hands any other scheme to the system', () => {
        const navigate = vi.fn();
        const openExternal = vi.fn(() => Promise.resolve());
        openLink('mailto:someone@example.com', { navigate, openExternal });
        expect(openExternal).toHaveBeenCalledWith('mailto:someone@example.com');
        expect(navigate).not.toHaveBeenCalled();
    });
});
