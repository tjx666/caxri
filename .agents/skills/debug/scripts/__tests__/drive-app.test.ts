import { describe, expect, it } from 'vitest';

import { parseDriveCommand, settingsSourceWithLanguage } from '../drive-app';

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
    });

    it('rejects an unknown step, a split argument, and a relative screenshot path', () => {
        expect(() => parseDriveCommand(['click', 'Save'], {})).toThrow(/Pass a step/u);
        expect(() => parseDriveCommand(['send', 'two', 'words'], {})).toThrow(/Quote/u);
        expect(() => parseDriveCommand(['screenshot', 'shot.png'], {})).toThrow(/absolute/u);
        expect(() => parseDriveCommand(['idle', 'soon'], {})).toThrow(/seconds/u);
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
