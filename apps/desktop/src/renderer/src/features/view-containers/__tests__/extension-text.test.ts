import type { SourceControlViewModel, TreeItemDto } from '@caxri/protocol';
import { interpolate } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../i18n';
import { viewContainersExtensionText } from '../../../i18n/locales/en/view-containers-extension-text';
import { localeDictionaries } from '../../../i18n/resources';
import { extensionTextKey, localizeExtensionParts, localizeExtensionText } from '../extension-text';
import { localizeTreeChildren } from '../extension-tree-text';
import {
    localizeActionEffect,
    localizeHistorySummary,
    localizeSourceControlModel,
} from '../source-control/source-control-model-text';

const zh: Translate = (key, parameters) =>
    interpolate(localeDictionaries['zh-CN'][key] ?? key, parameters);
const en: Translate = (key, parameters) =>
    interpolate(localeDictionaries.en[key] ?? key, parameters);

/**
 * Fills each placeholder with a sample (digits for numeric ones) so a template can be matched against its own rendered
 * sentence.
 */
function sample(template: string): string {
    return template.replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) =>
        ['count', 'number', 'shown', 'total'].includes(name) ? '7' : `<${name}>`,
    );
}

describe('extension text catalog', () => {
    it('resolves every English sentence to its own key', () => {
        for (const [key, template] of Object.entries(viewContainersExtensionText))
            expect(extensionTextKey(sample(template)), key).toBe(key);
    });

    it('leaves English untouched and translates every entry for Chinese', () => {
        for (const [key, template] of Object.entries(viewContainersExtensionText)) {
            const text = sample(template);
            expect(localizeExtensionText(text, en), key).toBe(text);
            expect(localizeExtensionText(text, zh), key).not.toBe(text);
        }
    });

    it('translates templated sentences with their captured values', () => {
        expect(localizeExtensionText('Sync Changes in caxri', zh)).toBe('同步 caxri 中的更改');
        expect(localizeExtensionText('Showing the first 5 of 9 changes', zh)).toBe(
            '显示前 5 项，共 9 项更改',
        );
        expect(localizeExtensionText('Open changes in src/a.ts', zh)).toBe(
            '打开 src/a.ts 中的更改',
        );
    });

    it('passes data and unknown sentences through unchanged', () => {
        for (const text of ['main', 'feat/changes', 'Fix the Commits list', 'Some other copy.'])
            expect(localizeExtensionText(text, zh)).toBe(text);
    });

    it('translates the parts of a composed hover and keeps the data parts', () => {
        expect(
            localizeExtensionParts('feat/x · tracking origin/feat/x · 2 ahead, 1 behind', zh),
        ).toBe('feat/x · 跟踪 origin/feat/x · 领先 2, 落后 1');
        expect(localizeExtensionParts(' · 3 uncommitted', zh)).toBe(' · 3 个未提交');
        expect(localizeExtensionParts('feat/a, b', zh)).toBe('feat/a, b');
    });

    it('keeps the truncation plus sign on a history summary', () => {
        expect(localizeHistorySummary('3 files changed+ · 1 hidden', zh)).toBe(
            '3 个文件已更改+ · 1 个已隐藏',
        );
        expect(localizeHistorySummary('1 file changed', en)).toBe('1 file changed');
    });

    it('translates a toast the extension raised', () => {
        expect(
            localizeActionEffect(
                { kind: 'toast', message: 'Synced with remote', tone: 'success' },
                zh,
            ),
        ).toMatchObject({ message: '已与远程同步' });
    });
});

const icon = { kind: 'theme', id: 'diff' } as const;
const action = {
    id: 'a1',
    label: 'Sync Changes in app',
    icon,
    command: { id: 'caxri.git.sync' },
    progressLabel: 'Syncing app',
    errorMessage: 'Sync failed',
} as const;

describe('Source Control model localization', () => {
    const model: SourceControlViewModel = {
        revision: '1',
        title: 'Source Control',
        accessibilityLabel: 'Git repositories',
        modeAccessibilityLabel: 'Source control mode',
        modes: [{ id: 'working', label: 'Working Tree Changes', icon, command: { id: 'x' } }],
        selectedModeId: 'working',
        refreshAction: { ...action, id: 'r', label: 'Refresh Git' },
        providers: [
            {
                id: 'repo',
                label: 'Commits',
                icon,
                tooltip: '/work/Commits',
                description: 'Detached HEAD',
                descriptionKind: 'commit',
                descriptionBadge: 'detached',
                descriptionAccessibilityLabel: 'Detached HEAD, 2 ahead, 1 behind',
                descriptionTooltip: 'Detached HEAD · tracking origin/main',
                countLabel: ' · 2 · 1 uncommitted',
                expandedByDefault: true,
                actions: [action],
                groups: [
                    {
                        id: 'g',
                        label: 'Changes',
                        count: 0,
                        expandedByDefault: true,
                        emptyMessage: 'Working tree clean.',
                        actions: [],
                        resources: [],
                    },
                ],
            },
        ],
    };

    it('translates chrome and keeps repository data', () => {
        const localized = localizeSourceControlModel(model, zh);
        expect(localized.title).toBe('源代码管理');
        expect(localized.modes[0].label).toBe('工作区更改');
        expect(localized.refreshAction.label).toBe('刷新 Git');
        const [provider] = localized.providers;
        // A repository that happens to be called `Commits` is data, not the History heading.
        expect(provider.label).toBe('Commits');
        expect(provider.tooltip).toBe('/work/Commits');
        expect(provider.description).toBe('分离的 HEAD');
        expect(provider.descriptionBadge).toBe('已分离');
        expect(provider.descriptionAccessibilityLabel).toBe('分离的 HEAD, 领先 2, 落后 1');
        expect(provider.descriptionTooltip).toBe('分离的 HEAD · 跟踪 origin/main');
        expect(provider.countLabel).toBe(' · 2 · 1 个未提交');
        expect(provider.actions[0]).toMatchObject({
            label: '同步 app 中的更改',
            progressLabel: '正在同步 app',
            errorMessage: '同步失败',
            command: { id: 'caxri.git.sync' },
        });
        expect(provider.groups[0]).toMatchObject({
            label: '更改',
            emptyMessage: '工作区没有更改。',
        });
    });

    it('is the identity in English', () => {
        expect(localizeSourceControlModel(model, en)).toEqual(model);
    });
});

describe('Status tree localization', () => {
    const items: TreeItemDto[] = [
        {
            handle: 'h1',
            variant: 'message',
            label: 'No Git repository',
            description: 'Initialize a Git repository in the Project root, then refresh.',
            accessibilityLabel: 'No Git repository',
            collapsibleState: 'none',
            command: { id: 'caxri.project-status.refresh', title: 'Refresh' },
        },
        {
            handle: 'h2',
            label: 'feat/Refresh',
            description: 'default · No origin',
            accessibilityLabel: 'feat/Refresh, default · No origin',
            collapsibleState: 'none',
            tooltip: {
                kind: 'rich',
                title: 'feat/Refresh',
                description: 'Project Status compares nothing here.',
                badge: { label: 'No origin', tone: 'neutral' },
                rows: [{ label: 'branch', value: 'Deployments' }],
            },
        },
    ];

    it('translates the Status view and leaves other views alone', () => {
        const children = new Map([['__root__', items]]);
        const [first, second] = localizeTreeChildren(
            'caxri.project-status.overview',
            children,
            zh,
        ).get('__root__')!;
        expect(first).toMatchObject({
            label: '没有 Git 仓库',
            description: '请在项目根目录中初始化 Git 仓库，然后刷新。',
            command: { id: 'caxri.project-status.refresh', title: '刷新' },
        });
        expect(second).toMatchObject({
            label: 'feat/Refresh',
            description: '默认 · 没有 origin',
            tooltip: {
                badge: { label: '没有 origin' },
                rows: [{ label: '分支', value: 'Deployments' }],
            },
        });
        expect(localizeTreeChildren('vendor.view', children, zh)).toBe(children);
    });
});
