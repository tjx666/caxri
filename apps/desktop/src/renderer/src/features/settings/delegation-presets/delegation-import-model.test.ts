import { CaxriError, interpolate } from '@caxri/protocol';
import { expect, it } from 'vitest';

import { withLocale } from '../../../i18n';
import { localeDictionaries } from '../../../i18n/resources';
import type { DelegationImportPreview } from './delegation-import-model';
import {
    changedPresetLines,
    importCounts,
    importIssueLines,
    importIssues,
    isStalePreview,
    otherChangeLines,
    presetNameLines,
} from './delegation-import-model';

function translateFor(locale: 'en' | 'zh-CN') {
    return withLocale(
        (key, parameters) => interpolate(localeDictionaries[locale][key] ?? key, parameters),
        locale,
    );
}

const preview: DelegationImportPreview = {
    dryRun: true,
    mode: 'replace',
    changed: true,
    revision: 'a'.repeat(64),
    presetNames: ['review'],
    maxDepth: 4,
    diff: {
        presets: {
            added: ['review'],
            changed: [{ name: 'keep-me', fields: ['model', 'effort'] }],
            removed: ['only-here', 'old'],
            unchanged: [],
        },
        callers: {
            added: ['claude'],
            removed: ['grok'],
            changed: [{ provider: 'codex', fields: ['prepend'] }],
        },
        settings: ['maxDepth'],
    },
};

it.each(['en', 'zh-CN'] as const)('describes every change of a preview in %s', (locale) => {
    const t = translateFor(locale);
    expect(importCounts(preview.diff)).toEqual({ added: 1, changed: 1, removed: 2 });
    expect(changedPresetLines(preview.diff, t)).toEqual([
        locale === 'en' ? 'keep-me: model and effort' : 'keep-me: 模型和推理强度',
    ]);
    const lines = otherChangeLines(preview, t);
    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).toContain('Claude');
    expect(lines.join('\n')).toContain(
        locale === 'en' ? 'Codex (text before the task)' : 'Codex (任务前置文本)',
    );
    expect(lines.join('\n')).toContain('4');
});

it('lists every added and removed preset by name', () => {
    expect(presetNameLines(preview.diff, translateFor('en'))).toEqual([
        'Adds: review',
        'Removes: only-here and old',
    ]);
    expect(presetNameLines(preview.diff, translateFor('zh-CN'))).toEqual([
        '新增：review',
        '移除：only-here和old',
    ]);
});

it('words issues from the closed reason set with a position and the merge stage', () => {
    const t = translateFor('en');
    expect(
        importIssueLines(
            [
                { stage: 'source', path: 'agents.0', reason: 'unknown_field' },
                { stage: 'source', path: '', reason: 'invalid_jsonc', line: 2, column: 5 },
                { stage: 'result', path: 'presets', reason: 'too_many' },
            ],
            t,
        ),
    ).toEqual([
        'agents.0: unsupported field',
        'file: not valid JSONC (line 2, column 5)',
        'After merging: presets: too many entries',
    ]);
    expect(
        importIssueLines(
            [{ stage: 'source', path: 'a', reason: 'missing' }],
            translateFor('zh-CN'),
        )[0],
    ).toContain('缺少');
});

it('reads issues and the stale marker only from the matching errors', () => {
    const issues = [{ stage: 'source', path: '', reason: 'too_large' }];
    expect(importIssues(new CaxriError('VALIDATION', 'x', { issues }))).toEqual(issues);
    expect(importIssues(new CaxriError('VALIDATION', 'x', { issues: 'nope' }))).toEqual([]);
    expect(importIssues(new Error('x'))).toEqual([]);
    expect(isStalePreview(new CaxriError('CONFLICT', 'x', { reason: 'stale_preview' }))).toBe(true);
    expect(isStalePreview(new CaxriError('CONFLICT', 'x'))).toBe(false);
});
