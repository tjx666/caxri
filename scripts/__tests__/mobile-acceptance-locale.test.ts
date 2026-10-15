import { describe, expect, it } from 'vitest';

import { prepareMobileAppLocale } from '../mobile-acceptance-locale';

const device = (answers: { sdk: string; applied: string }) => {
    const actions: string[] = [];
    return {
        actions,
        commands: {
            readDevice: (arguments_: string[]) =>
                arguments_.includes('getprop') ? answers.sdk : answers.applied,
            runDevice: (arguments_: string[]) => {
                actions.push(arguments_.join(' '));
            },
        },
    };
};

describe('mobile acceptance app language', () => {
    it('sets the per-app language and resets it to the system language once', () => {
        const { actions, commands } = device({
            sdk: '36\n',
            applied: 'Locales for com.caxri.mobile for user 0 are [zh-CN]\n',
        });
        const reset = prepareMobileAppLocale('emulator-5554', commands, 'zh-CN');
        reset();
        reset();

        expect(actions).toEqual([
            'shell cmd locale set-app-locales com.caxri.mobile --locales zh-CN',
            "shell cmd locale set-app-locales com.caxri.mobile --locales ''",
        ]);
    });

    it('resets and fails when the emulator does not report the language', () => {
        const { actions, commands } = device({
            sdk: '36',
            applied: 'Locales for com.caxri.mobile for user 0 are []',
        });

        expect(() => prepareMobileAppLocale('emulator-5554', commands, 'zh-CN')).toThrow(
            'The emulator did not apply the app language',
        );
        expect(actions.at(-1)).toBe(
            "shell cmd locale set-app-locales com.caxri.mobile --locales ''",
        );
    });

    it('refuses an emulator older than Android 13 without touching it', () => {
        const { actions, commands } = device({ sdk: '32', applied: '' });

        expect(() => prepareMobileAppLocale('emulator-5554', commands, 'zh-CN')).toThrow(
            'App language requires Android 13 or later',
        );
        expect(actions).toEqual([]);
    });

    it('refuses a device that is not an explicit emulator', () => {
        const { commands } = device({ sdk: '36', applied: '' });

        expect(() => prepareMobileAppLocale('R5CT1234', commands, 'zh-CN')).toThrow(
            'App language requires an explicit disposable emulator',
        );
    });
});
