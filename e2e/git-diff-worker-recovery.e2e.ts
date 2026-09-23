import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

test('a paused diff worker reports a stall and recovers when its startup resumes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-diff-worker-'));
    const root = join(directory, 'project');
    const profile = join(directory, 'profile');
    await mkdir(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'example.txt'), 'alpha\nbeta\ngamma\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    await writeFile(join(root, 'example.txt'), 'alpha\nchanged\ngamma\nnew line\n');
    const running = await launchCaxri({ userDataDir: profile, testRootPath: root });
    try {
        const page = running.page;
        await page.addInitScript(() => {
            const NativeWorker = Worker;
            const paused: Worker[] = [];
            const scope = globalThis as typeof window & { resumeFixtureWorkers?: () => void };
            scope.resumeFixtureWorkers = () => {
                for (const worker of paused) worker.postMessage('caxri-resume-fixture');
            };
            /**
             * Delay only the real editor worker's module body; preserve its queued bootstrap messages.
             */
            scope.Worker = class extends NativeWorker {
                constructor(url: string | URL, options?: WorkerOptions) {
                    if (!String(url).includes('editor.worker')) {
                        super(url, options);
                        return;
                    }
                    const moduleUrl = new URL(String(url), location.href).href;
                    const source = `const queued=[]; let resumed=false;
                        const receive=async(event)=>{
                            if(event.data!=="caxri-resume-fixture"){queued.push(event.data);return;}
                            if(resumed)return;resumed=true;
                            await import(${JSON.stringify(moduleUrl)});
                            self.removeEventListener("message",receive);
                            for(const data of queued)self.dispatchEvent(new MessageEvent("message",{data: data}));
                        };self.addEventListener("message",receive);`;
                    const blob = URL.createObjectURL(
                        new Blob([source], { type: 'text/javascript' }),
                    );
                    super(blob, { ...options, type: 'module' });
                    URL.revokeObjectURL(blob);
                    paused.push(this);
                }
            };
        });
        await page.reload();
        await createProjectSession(page);
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        await page
            .locator('.git-repository-section')
            .getByRole('treeitem', { name: 'example.txt', exact: true })
            .click();
        const diff = page.locator('.git-file-diff');
        await expect(diff.getByText('This comparison never started', { exact: false })).toBeVisible(
            { timeout: 15000 },
        );
        await page.screenshot({
            path: test.info().outputPath('diff-worker-stalled.png'),
            mask: [page.locator('.xterm')],
        });
        await page.evaluate(() => {
            (
                globalThis as typeof window & { resumeFixtureWorkers: () => void }
            ).resumeFixtureWorkers();
        });
        await expect(diff.locator('.line-insert').first()).toBeVisible();
        await expect(diff.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
        await page.screenshot({
            path: test.info().outputPath('diff-worker-recovered.png'),
            mask: [page.locator('.xterm')],
        });
        await expect
            .poll(async () => {
                const lines = (await readFile(join(profile, 'logs', 'desktop.jsonl'), 'utf8'))
                    .split('\n')
                    .filter(Boolean);
                return lines
                    .map(
                        (line) =>
                            JSON.parse(line) as { fields?: { code?: string; outcome?: string } },
                    )
                    .filter((entry) => entry.fields?.code === 'EDITOR_WORKER_STALL')
                    .map((entry) => entry.fields?.outcome);
            })
            .toEqual(['timeout', 'recovered']);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
