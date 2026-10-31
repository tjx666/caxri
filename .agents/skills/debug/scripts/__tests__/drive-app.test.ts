import { describe, expect, it } from 'vitest';

import { chatChoiceName, parseDriveCommand, splitHeldChord } from '../drive-app';
import { idleComparableText } from '../drive-app-idle';
import {
    settingsSourceWithLanguage,
    settingsSourceWithTrustedFolders,
} from '../drive-app-settings';

describe('drive-app', () => {
    it('reads a step, its argument, and a trailing screenshot path', () => {
        expect(
            parseDriveCommand(
                ['send', 'Summarize the plan', '--screenshot', '/tmp/a/sent.png'],
                {},
            ),
        ).toEqual({
            step: 'send',
            argument: 'Summarize the plan',
            screenshot: '/tmp/a/sent.png',
            inspectorPort: undefined,
        });
        expect(parseDriveCommand(['idle'], {}).step).toBe('idle');
        expect(parseDriveCommand(['paste-image'], {}).step).toBe('paste-image');
        expect(parseDriveCommand(['paste-image', '2'], {}).argument).toBe('2');
    });

    it('waits for a starting dev instance without an argument and opens a Session by id prefix or title', () => {
        expect(parseDriveCommand(['ready'], {}).step).toBe('ready');
        expect(parseDriveCommand(['ready', '90'], {}).argument).toBe('90');
        expect(() => parseDriveCommand(['ready', 'soon'], {})).toThrow(/seconds/u);
        expect(parseDriveCommand(['select-session', '810bc7fd'], {}).argument).toBe('810bc7fd');
        expect(() => parseDriveCommand(['select-session'], {})).toThrow(/needs an argument/u);
    });

    it('runs a palette command only by an exact command id', () => {
        expect(parseDriveCommand(['command', 'usage.open'], {}).argument).toBe('usage.open');
        expect(() => parseDriveCommand(['command', 'Open Usage'], {})).toThrow(/command id/u);
        expect(() => parseDriveCommand(['command'], {})).toThrow(/needs an argument/u);
    });

    it('rejects an unknown step, a split argument, and a relative screenshot path', () => {
        expect(() => parseDriveCommand(['click', 'Save'], {})).toThrow(/Pass a step/u);
        expect(() => parseDriveCommand(['send', 'two', 'words'], {})).toThrow(/Quote/u);
        expect(() => parseDriveCommand(['screenshot', 'shot.png'], {})).toThrow(/absolute/u);
        expect(() => parseDriveCommand(['idle', 'soon'], {})).toThrow(/seconds/u);
        expect(() => parseDriveCommand(['paste-image', 'many'], {})).toThrow(/count/u);
    });

    it('switches to a built-in theme by id or a theme file by absolute path', () => {
        expect(parseDriveCommand(['theme', 'solarized-light'], {}).argument).toBe(
            'solarized-light',
        );
        expect(parseDriveCommand(['theme', '/tmp/a/theme.json'], {}).argument).toBe(
            '/tmp/a/theme.json',
        );
        expect(() => parseDriveCommand(['theme', 'light'], {})).toThrow(/solarized-light/u);
        expect(() => parseDriveCommand(['theme', 'theme.json'], {})).toThrow(/absolute/u);
        expect(() => parseDriveCommand(['theme'], {})).toThrow(/needs an argument/u);
    });

    it('opens a Chat only for a known Agent provider', () => {
        expect(parseDriveCommand(['open-chat', 'codex'], {}).argument).toBe('codex');
        expect(() => parseDriveCommand(['open-chat', 'shell'], {})).toThrow(/claude, codex/u);
        expect(() => parseDriveCommand(['open-chat'], {})).toThrow(/needs an argument/u);
    });

    it('creates a Shell Session by default or an Agent Session for a known provider', () => {
        expect(parseDriveCommand(['new-session'], {}).argument).toBeUndefined();
        expect(parseDriveCommand(['new-session', 'shell'], {}).argument).toBe('shell');
        expect(parseDriveCommand(['new-session', 'grok'], {}).argument).toBe('grok');
        expect(() => parseDriveCommand(['new-session', 'zsh'], {})).toThrow(/shell, claude/u);
    });

    it('holds the modifiers of a chord across a counted number of presses', () => {
        expect(
            parseDriveCommand(
                ['hold-press', 'Control+Alt+Tab', '--times', '2', '--screenshot', '/tmp/a/mru.png'],
                {},
            ),
        ).toEqual({
            step: 'hold-press',
            argument: 'Control+Alt+Tab',
            screenshot: '/tmp/a/mru.png',
            inspectorPort: undefined,
            times: 2,
        });
        expect(parseDriveCommand(['hold-press', 'Control+Alt+Tab'], {}).times).toBeUndefined();
        expect(splitHeldChord('Control+Alt+Tab')).toEqual({
            modifiers: ['Control', 'Alt'],
            key: 'Tab',
        });
        expect(splitHeldChord('Meta++')).toEqual({ modifiers: ['Meta'], key: '+' });
        expect(() => parseDriveCommand(['hold-press', 'Tab'], {})).toThrow(/modifiers and a key/u);
        expect(() => parseDriveCommand(['hold-press'], {})).toThrow(/needs an argument/u);
        expect(() => parseDriveCommand(['hold-press', 'Control+Tab', '--times', '0'], {})).toThrow(
            /positive count/u,
        );
        expect(() => parseDriveCommand(['send', 'hi', '--times', '2'], {})).toThrow(
            /Only `hold-press`/u,
        );
    });

    it('takes the Main inspector port from the flag or the variable the dev launch exported', () => {
        expect(() => parseDriveCommand(['stub-folder-dialog', '/tmp/a/project'], {})).toThrow(
            /V8_INSPECTOR_PORT/u,
        );
        expect(
            parseDriveCommand(['stub-folder-dialog', '/tmp/a/project'], {
                V8_INSPECTOR_PORT: '9339',
            }).inspectorPort,
        ).toBe(9339);
        expect(
            parseDriveCommand(
                ['stub-folder-dialog', '/tmp/a/project', '--inspector-port', '9440'],
                {
                    V8_INSPECTOR_PORT: '9339',
                },
            ).inspectorPort,
        ).toBe(9440);
    });

    it('finds the Chat row of the add-Project dialog in either interface language', () => {
        expect(chatChoiceName('codex').test('Codex Chat')).toBe(true);
        expect(chatChoiceName('codex').test('Codex对话')).toBe(true);
        expect(chatChoiceName('codex').test('Codex')).toBe(false);
        expect(chatChoiceName('claude').test('Codex Chat')).toBe(false);
    });

    it('appends trusted folders once, keeping the rules already set', () => {
        const settings = { 'editor.fontSize': 13, 'security.trustedFolders': ['/tmp/a'] };

        expect(
            JSON.parse(settingsSourceWithTrustedFolders(settings, ['/tmp/a', '/private/tmp/a'])),
        ).toEqual({
            'editor.fontSize': 13,
            'security.trustedFolders': ['/tmp/a', '/private/tmp/a'],
        });
        expect(() => parseDriveCommand(['trust-folder', 'relative/folder'], {})).toThrow(
            /absolute folder path/u,
        );
    });

    it('writes the language into the whole settings source that settings.update replaces', () => {
        const settings = { 'editor.fontSize': 13, 'workbench.language': 'zh-CN' };

        expect(JSON.parse(settingsSourceWithLanguage(settings, 'en'))).toEqual({
            'editor.fontSize': 13,
            'workbench.language': 'en',
        });
        const followsSystem = JSON.parse(settingsSourceWithLanguage(settings, 'system')) as Record<
            string,
            unknown
        >;
        expect(followsSystem['workbench.language']).toBeNull();
        expect(() => settingsSourceWithLanguage(settings, 'fr')).toThrow(/Language/u);
    });

    it('lets idle settle while figures tick but not while a reply streams', () => {
        expect(idleComparableText('Watch the build 1m 59s · 12 turns')).toBe(
            idleComparableText('Watch the build 2m 0s · 13 turns'),
        );
        expect(idleComparableText('The build passed')).not.toBe(
            idleComparableText('The build passed and'),
        );
    });
});
