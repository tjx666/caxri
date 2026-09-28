import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { validatePlanFixtureDeclarations } from '../plan-fixtures';
import type { InitializeReportInput } from '../report';
import { initializeReport } from '../report';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
/**
 * The production path guard requires report fixtures under the real project `.records/` root.
 */
const TEST_ROOT = join(
    PROJECT_ROOT,
    '.records',
    '__test__',
    `acceptance-plan-fixtures-${process.pid}`,
);

/**
 * Neutral wording by default, so each case below adds exactly the text that should trigger the freeze-time check.
 */
function planItem(overrides: Record<string, unknown> = {}) {
    return {
        category: '设置',
        expected: '设置页显示反馈。',
        id: 'settings-feedback',
        method: '打开设置页。',
        requiredEvidence: ['screenshot'],
        surface: 'desktop',
        title: '设置页反馈',
        ...overrides,
    } satisfies InitializeReportInput['plan'][number];
}

const themeImportItem = {
    id: 'settings-theme-import-feedback',
    method: '在设置页点击 Import Theme 并选择测试主题文件。',
};

afterAll(async () => {
    await rm(TEST_ROOT, { force: true, recursive: true });
});

describe('Acceptance plan fixture declarations', () => {
    it.each([
        ['an English method', { method: 'Click Import Theme and pick the fixture file.' }],
        ['a Chinese title', { title: '导入一个主题后的反馈' }],
        ['a Chinese expectation', { expected: '主题导入后列表颜色一致。' }],
        ['a case id', { id: 'list-tokens-theme-import-parity' }],
        ['the Main request name', { expected: 'theme.import 返回新主题。' }],
        ['a theme file choice', { method: '选择 fixture.itermcolors 文件并检查颜色。' }],
        ['a Chinese theme file', { method: '选择测试用的主题文件。' }],
    ])('fails at freeze time when %s drives theme import without a declaration', (_, fields) => {
        const item = planItem(fields);
        expect(() => validatePlanFixtureDeclarations([item])).toThrow(
            `Acceptance case ${item.id} imports a theme but does not declare themeImportFixture`,
        );
    });

    it('accepts an explicit declaration either way', () => {
        expect(() =>
            validatePlanFixtureDeclarations([
                planItem({ ...themeImportItem, themeImportFixture: true }),
                planItem({
                    ...themeImportItem,
                    id: 'theme-native-handoff',
                    themeImportFixture: false,
                }),
            ]),
        ).not.toThrow();
    });

    it('ignores cases that never mention theme import', () => {
        expect(() =>
            validatePlanFixtureDeclarations([planItem({ title: '切换主题后颜色刷新' })]),
        ).not.toThrow();
    });

    it.each([
        { themeImportFixture: true },
        { themeImportFixture: false },
        { updateFixture: 'available' as const },
    ])('rejects %o on a non-desktop case', (fixture) => {
        expect(() =>
            validatePlanFixtureDeclarations([
                planItem({ id: 'mobile-case', surface: 'mobile', ...fixture }),
            ]),
        ).toThrow('only a desktop case can use');
    });

    it('stops init before creating the round when a theme import case is undeclared', async () => {
        await mkdir(TEST_ROOT, { recursive: true });
        const directory = join(await mkdtemp(join(TEST_ROOT, 'case-')), 'round-1');
        await expect(
            initializeReport({
                directory,
                entry: '在 Caxri Electron 设置页导入主题。',
                plan: [planItem(themeImportItem)],
                requirement: '导入主题后设置页给出反馈。',
                title: '验收主题导入反馈',
            }),
        ).rejects.toThrow('settings-theme-import-feedback imports a theme');
        await expect(access(directory)).rejects.toThrow();
    });

    it('rejects an unknown update fixture id when the plan is parsed', async () => {
        await mkdir(TEST_ROOT, { recursive: true });
        const directory = join(await mkdtemp(join(TEST_ROOT, 'case-')), 'round-1');
        await expect(
            initializeReport({
                directory,
                entry: '在 Caxri Electron 中等待更新通知。',
                plan: [planItem({ id: 'update-notification', updateFixture: 'ready' })],
                requirement: '启动后看到可用更新通知。',
                title: '验收更新通知',
            }),
        ).rejects.toThrow();
    });
});
