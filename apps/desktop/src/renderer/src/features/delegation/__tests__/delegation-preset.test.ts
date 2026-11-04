import { interpolate } from '@caxri/protocol';
import { expect, it } from 'vitest';

import { withLocale } from '../../../i18n';
import { localeDictionaries } from '../../../i18n/resources';
import { delegationPresetSummary } from '../delegation-preset';

function translateFor(locale: 'en' | 'zh-CN') {
    return withLocale(
        (key, parameters) => interpolate(localeDictionaries[locale][key] ?? key, parameters),
        locale,
    );
}

it('summarizes the frozen selection of a preset task with provider, model and effort', () => {
    expect(
        delegationPresetSummary(
            { provider: 'codex', model: 'gpt-5.5', effort: 'high', preset: 'review' },
            translateFor('en'),
        ),
    ).toBe('Preset review: Codex, gpt-5.5, high');
    expect(
        delegationPresetSummary({ provider: 'claude', preset: 'review' }, translateFor('zh-CN')),
    ).toBe('预设 review：Claude、默认模型、默认强度');
});

it('has no summary for a task started without a preset', () => {
    expect(delegationPresetSummary({ provider: 'claude' }, translateFor('en'))).toBeUndefined();
    expect(delegationPresetSummary(undefined, translateFor('en'))).toBeUndefined();
});
