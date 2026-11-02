import type { AppSettings, ThemeTokens } from '@caxri/protocol';
import { builtinThemes, defaultDarkThemeId, defaultLightThemeId } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { draculaTheme, SystemAppearance } from '..';

function presetColors(id: string) {
    const { background, foreground } = builtinThemes.find((theme) => theme.id === id)!.terminal;
    return { background, foreground };
}

function createAppearance(settings: Record<string, unknown>, imported: ThemeTokens[] = []) {
    const listeners = new Set<() => void>();
    const config = {
        getSettings: () => ({ value: settings as unknown as AppSettings }),
        getTheme: () => ({ value: draculaTheme, imported }),
        subscribeSettings: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return { appearance: new SystemAppearance(config), listeners };
}

const following = {
    'workbench.theme.followSystem': true,
    'workbench.theme.light': defaultLightThemeId,
    'workbench.theme.dark': defaultDarkThemeId,
};

describe('SystemAppearance terminal colors', () => {
    it('answers with the dark preset until a Desktop reports an appearance', () => {
        const { appearance } = createAppearance(following);
        expect(appearance.terminalColors()).toEqual(presetColors(defaultDarkThemeId));
    });

    it('follows a reported light appearance and returns to dark', () => {
        const { appearance } = createAppearance(following);
        appearance.set('light');
        expect(appearance.terminalColors()).toEqual(presetColors(defaultLightThemeId));
        appearance.set('dark');
        expect(appearance.terminalColors()).toEqual(presetColors(defaultDarkThemeId));
    });

    it('answers with an imported theme a slot names', () => {
        const paper = {
            ...builtinThemes.find((theme) => theme.id === defaultLightThemeId)!,
            id: 'imported-paper',
            name: 'Paper',
            terminal: { ...draculaTheme.terminal, background: '#fafafa', foreground: '#111111' },
        };
        const { appearance } = createAppearance(
            { ...following, 'workbench.theme.light': 'imported-paper' },
            [paper],
        );
        appearance.set('light');
        expect(appearance.terminalColors()).toEqual({
            background: '#fafafa',
            foreground: '#111111',
        });
    });

    it('keeps the saved theme when not following the system', () => {
        const { appearance } = createAppearance({
            ...following,
            'workbench.theme.followSystem': false,
        });
        appearance.set('light');
        expect(appearance.terminalColors()).toEqual({
            background: draculaTheme.terminal.background,
            foreground: draculaTheme.terminal.foreground,
        });
    });

    it('notifies on a real appearance change and on a settings change, until unsubscribed', () => {
        const { appearance, listeners } = createAppearance(following);
        const listener = vi.fn();
        const unsubscribe = appearance.onChange(listener);
        appearance.set('dark');
        expect(listener).not.toHaveBeenCalled();
        appearance.set('light');
        expect(listener).toHaveBeenCalledTimes(1);
        for (const settingsListener of listeners) settingsListener();
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
        appearance.set('dark');
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listeners.size).toBe(0);
    });
});
