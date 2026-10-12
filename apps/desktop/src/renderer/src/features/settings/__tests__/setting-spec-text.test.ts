import type { EnumSettingSpec } from '@caxri/protocol';
import { settingsSpecByKey } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { applyLanguagePreference, translate } from '../../../i18n';
import { settingCategoryPath, settingNullLabel } from '../setting-spec-text';

describe('settingCategoryPath', () => {
    afterEach(() => {
        applyLanguagePreference(null);
    });

    it('names the category the setting actually lives in, in the Settings sidebar wording', () => {
        expect(settingCategoryPath(translate, 'terminal.idleSuspension.enabled')).toBe(
            'Settings › Agents',
        );
        applyLanguagePreference('zh-CN');
        expect(settingCategoryPath(translate, 'terminal.idleSuspension.enabled')).toBe(
            '设置 › Agent',
        );
    });
});

describe('settingNullLabel', () => {
    afterEach(() => {
        applyLanguagePreference(null);
    });

    const language = settingsSpecByKey['workbench.language'] as EnumSettingSpec;

    it('names the language Follow system resolves to', () => {
        expect(settingNullLabel(translate, language, ['en-US'])).toBe('Follow system (English)');
        applyLanguagePreference('zh-CN');
        expect(settingNullLabel(translate, language, ['zh-Hans-CN'])).toBe('跟随系统（简体中文）');
    });

    it('keeps the plain null label for other settings', () => {
        const agent = settingsSpecByKey['session.defaultAgent'] as EnumSettingSpec;
        expect(settingNullLabel(translate, agent, ['en-US'])).toBe('Ask each time');
    });
});
