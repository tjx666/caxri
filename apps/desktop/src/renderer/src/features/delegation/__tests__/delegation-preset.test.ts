import { interpolate } from '@caxri/protocol';
import { expect, it } from 'vitest';

import { withLocale } from '../../../i18n';
import { localeDictionaries } from '../../../i18n/resources';
import {
    delegationPresetDetail,
    delegationPresetSummary,
    delegationSelectionLabel,
} from '../delegation-preset';

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

it('words the frozen provider, model and effort without the preset name', () => {
    expect(
        delegationPresetDetail(
            { provider: 'codex', model: 'gpt-5.5', effort: 'high', preset: 'review' },
            translateFor('en'),
        ),
    ).toBe('Codex, gpt-5.5, high');
    expect(delegationPresetDetail({ provider: 'claude' }, translateFor('en'))).toBeUndefined();
});

it('has no summary for a task started without a preset', () => {
    expect(delegationPresetSummary({ provider: 'claude' }, translateFor('en'))).toBeUndefined();
    expect(delegationPresetSummary(undefined, translateFor('en'))).toBeUndefined();
});

it('names a typed task by its type in the interface language', () => {
    const selection = { provider: 'codex' as const, type: 'review' as const };
    expect(delegationSelectionLabel(selection, translateFor('en'))).toBe('Review');
    expect(delegationPresetSummary(selection, translateFor('en'))).toBe(
        'Review: Codex, Provider default model, Default effort',
    );
    expect(
        delegationPresetSummary(
            { provider: 'claude', model: 'opus', type: 'second-opinion' },
            translateFor('zh-CN'),
        ),
    ).toBe('参考意见：Claude、opus、默认强度');
    expect(delegationSelectionLabel({ provider: 'claude' }, translateFor('en'))).toBeUndefined();
});
