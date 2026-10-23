import { describe, expect, it } from 'vitest';

import { chatChoiceName, parseDriveCommand, settingsSourceWithLanguage } from '../drive-app';

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

    it('rejects an unknown step, a split argument, and a relative screenshot path', () => {
        expect(() => parseDriveCommand(['click', 'Save'], {})).toThrow(/Pass a step/u);
        expect(() => parseDriveCommand(['send', 'two', 'words'], {})).toThrow(/Quote/u);
        expect(() => parseDriveCommand(['screenshot', 'shot.png'], {})).toThrow(/absolute/u);
        expect(() => parseDriveCommand(['idle', 'soon'], {})).toThrow(/seconds/u);
        expect(() => parseDriveCommand(['paste-image', 'many'], {})).toThrow(/count/u);
    });

    it('opens a Chat only for a known Agent provider', () => {
        expect(parseDriveCommand(['open-chat', 'codex'], {}).argument).toBe('codex');
        expect(() => parseDriveCommand(['open-chat', 'shell'], {})).toThrow(/claude, codex/u);
        expect(() => parseDriveCommand(['open-chat'], {})).toThrow(/needs an argument/u);
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
});
