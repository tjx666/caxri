import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import type { InitializeReportInput } from './report';
import { initializeReport } from './report';
import { loadAcceptanceCasePlan } from './report-case-plan';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TEST_ROOT = join(PROJECT_ROOT, '.records', '__test__', `acceptance-case-plan-${process.pid}`);
const plan = [
    {
        category: '移动端配对',
        expected: 'Android 客户端能连接到等待中的 Agent Session 并发送一次短回复。',
        id: 'android-short-reply',
        method: '在一次性 Android 模拟器上运行发布构建并观察回复后的 Session 状态。',
        mobileDevice: { appId: 'com.caxri.mobile', deviceId: 'emulator-5554', platform: 'android' },
        requiredEvidence: ['text'],
        stateIsolation: { mode: 'isolated' },
        surface: 'mobile',
        title: 'Android 短回复到达等待中的 Agent',
        verifier: 'program',
    },
] satisfies InitializeReportInput['plan'];

async function initialize(commit?: string): Promise<string> {
    await mkdir(TEST_ROOT, { recursive: true });
    const directory = join(await mkdtemp(join(TEST_ROOT, 'case-')), 'round-1');
    await initializeReport({
        ...(commit && { commit }),
        directory,
        entry: '在指定移动设备上执行隔离验收。',
        plan,
        requirement: 'Caxri 移动端应安全连接并呈现配对的 Agent Sessions。',
        title: '验收 Caxri 移动端',
    });
    return directory;
}

afterAll(async () => {
    await rm(TEST_ROOT, { force: true, recursive: true });
});

describe('loadAcceptanceCasePlan', () => {
    it('returns the frozen commit and the planned case', async () => {
        const directory = await initialize('a'.repeat(40));

        const loaded = await loadAcceptanceCasePlan(directory, 'android-short-reply');

        expect(loaded.commit).toBe('a'.repeat(40));
        expect(loaded.item.id).toBe('android-short-reply');
        await expect(loadAcceptanceCasePlan(directory, 'missing')).rejects.toThrow(
            'Acceptance case missing is not present in the frozen plan',
        );
    });

    it('tells the runner how to freeze a round initialized without a commit', async () => {
        const directory = await initialize();

        await expect(loadAcceptanceCasePlan(directory, 'android-short-reply')).rejects.toThrow(
            'has no frozen source commit; initialize the round with `report.ts init --commit',
        );
    });
});
