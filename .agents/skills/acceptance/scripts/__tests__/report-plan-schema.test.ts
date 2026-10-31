import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import type { InitializeReportInput } from '../report';
import { initializeReport } from '../report';
import { planItemSchema } from '../report-plan-schema';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
/**
 * The production path guard requires report fixtures under the real project `.records/` root.
 */
const TEST_ROOT = join(
    PROJECT_ROOT,
    '.records',
    '__test__',
    `acceptance-plan-schema-${process.pid}`,
);

function planItem(overrides: Record<string, unknown> = {}) {
    return {
        category: '移动端页面预览',
        expected: '标题栏出现端口 chip，点按后应用内浏览器打开页面。',
        id: 'mobile-preview-chip',
        method: '在模拟器上打开 Session 并点按端口 chip。',
        requiredEvidence: ['screenshot'],
        surface: 'desktop',
        title: '手机预览本地开发服务器',
        ...overrides,
    } satisfies InitializeReportInput['plan'][number];
}

afterAll(async () => {
    await rm(TEST_ROOT, { force: true, recursive: true });
});

describe('Acceptance plan programmatic-gate check', () => {
    it.each([
        ['method', '设备角色限制由 Server 单元测试覆盖。', '单元测试'],
        ['method', '检查状态映射与外链 URL 由单测覆盖。', '单测'],
        ['expected', 'lint 通过且页面正常。', 'lint'],
        ['title', 'Unit tests cover the preview proxy', 'Unit tests'],
        ['category', '类型检查', '类型检查'],
        ['method', 'Run bun run check on the branch.', 'bun run check'],
        ['expected', 'CI 全绿。', 'CI 全绿'],
    ])('rejects a %s that names a programmatic gate', (field, text, gate) => {
        const result = planItemSchema.safeParse(planItem({ [field]: text }));
        expect(result.success).toBe(false);
        expect(result.error?.issues.map(({ message }) => message).join('\n')).toContain(
            `names the programmatic gate "${gate}"`,
        );
    });

    it.each([
        ['an ordinary product build word', { method: 'Open the build settings page.' }],
        ['a CI status shown in the product', { expected: 'Status 面板显示 CI 运行中。' }],
        ['a program-verified product outcome', { verifier: 'program' }],
    ])('accepts %s', (_, overrides) => {
        expect(planItemSchema.safeParse(planItem(overrides)).success).toBe(true);
    });

    it('stops init before creating the round', async () => {
        await mkdir(TEST_ROOT, { recursive: true });
        const directory = join(await mkdtemp(join(TEST_ROOT, 'case-')), 'round-1');
        await expect(
            initializeReport({
                directory,
                entry: 'Android：Session 详情页标题栏',
                plan: [planItem({ method: '端口归属由单元测试覆盖。' })],
                requirement: '手机上可以预览 Session 的本地开发服务器。',
                title: '手机预览本地开发服务器',
            }),
        ).rejects.toThrow('names the programmatic gate');
        await expect(access(directory)).rejects.toThrow();
    });
});
