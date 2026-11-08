import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn(), stored: undefined as unknown }));
vi.mock('../../../lib/local-storage', () => ({
    createSharedLocalState: (_key: string, parse: (raw: unknown) => unknown) => ({
        patch: vi.fn(),
        read: () => parse(mocks.stored),
        subscribe: vi.fn(() => () => {}),
        write: vi.fn(),
    }),
}));
vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { useChromeLayoutStore } from '../../../stores/chrome-layout';
import { useNotificationStore } from '../../../stores/notifications';
import { useWorkbenchStore } from '../../../stores/workbench';
import {
    isZenRestoredAtLaunch,
    parsePersistedZenMode,
    planZenFullScreen,
    startZenModeLifecycle,
} from '../zen-mode-lifecycle';

describe('planZenFullScreen', () => {
    const base = { isEnabled: true, isFullScreen: false, enteredFullScreen: false };

    it('enters full screen with Zen and remembers it owns it', () => {
        expect(planZenFullScreen('enter', base)).toEqual({
            setFullScreen: true,
            enteredFullScreen: true,
        });
    });

    it('leaves a window alone when the Setting is off or it is already full screen', () => {
        expect(planZenFullScreen('enter', { ...base, isEnabled: false })).toEqual({
            enteredFullScreen: false,
        });
        expect(planZenFullScreen('enter', { ...base, isFullScreen: true })).toEqual({
            enteredFullScreen: false,
        });
    });

    it('gives full screen back only when Zen took it', () => {
        expect(planZenFullScreen('leave', { ...base, enteredFullScreen: true })).toEqual({
            setFullScreen: false,
            enteredFullScreen: false,
        });
        expect(planZenFullScreen('leave', { ...base, isFullScreen: true })).toEqual({
            enteredFullScreen: false,
        });
    });
});

describe('parsePersistedZenMode', () => {
    it('falls back to inactive for missing or malformed entries', () => {
        expect(parsePersistedZenMode(undefined)).toEqual({
            isActive: false,
            enteredFullScreen: false,
        });
        expect(parsePersistedZenMode({ isActive: 'yes', enteredFullScreen: true })).toEqual({
            isActive: false,
            enteredFullScreen: false,
        });
        expect(parsePersistedZenMode({ isActive: true, enteredFullScreen: true })).toEqual({
            isActive: true,
            enteredFullScreen: true,
        });
    });
});

describe('startZenModeLifecycle', () => {
    beforeEach(() => {
        mocks.request.mockReset().mockResolvedValue({ isFullScreen: true });
        useChromeLayoutStore.setState({ zenMode: false });
        useWorkbenchStore.setState({ isFullScreen: false });
        useNotificationStore.setState({ isOpen: true });
    });

    it('requests full screen when Zen turns on and releases it when Zen ends by any path', () => {
        const stop = startZenModeLifecycle({
            isFullScreenEnabled: () => true,
            isRestoreEnabled: () => true,
        });
        useChromeLayoutStore.getState().toggleZenMode();
        expect(mocks.request).toHaveBeenLastCalledWith('window.fullScreen.set', {
            isFullScreen: true,
        });
        // A surface reveal clears Zen without going through the toggle.
        useChromeLayoutStore.getState().togglePanel();
        expect(useChromeLayoutStore.getState().zenMode).toBe(false);
        expect(mocks.request).toHaveBeenLastCalledWith('window.fullScreen.set', {
            isFullScreen: false,
        });
        stop();
    });

    it('closes the notification center when Zen hides the bell that owns it', () => {
        const stop = startZenModeLifecycle({
            isFullScreenEnabled: () => false,
            isRestoreEnabled: () => true,
        });
        useChromeLayoutStore.getState().toggleZenMode();
        expect(useNotificationStore.getState().isOpen).toBe(false);
        expect(mocks.request).not.toHaveBeenCalled();
        stop();
    });

    it('marks a launch-restored Zen until the user toggles it', () => {
        mocks.stored = { isActive: true };
        const stop = startZenModeLifecycle({
            isFullScreenEnabled: () => false,
            isRestoreEnabled: () => true,
        });
        expect(isZenRestoredAtLaunch()).toBe(true);
        useChromeLayoutStore.getState().toggleZenMode();
        expect(isZenRestoredAtLaunch()).toBe(false);
        stop();
        mocks.stored = undefined;
    });
});
