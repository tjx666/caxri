import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '..');

async function launch(
    userData: string,
    sessionRoot: string,
): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await electron.launch({
        args: ['.', '--disable-gpu'],
        cwd: projectRoot,
        env: {
            ...process.env,
            CAXRI_E2E: '1',
            CAXRI_USER_DATA_DIR: userData,
            CAXRI_TEST_ROOT_PATH: sessionRoot,
        },
    });
    const page = await app.firstWindow();
    await expect(page.getByText('Runtime ready')).toBeVisible();
    return { app, page };
}

async function createShellSession(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Add Project', exact: true }).last().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Shell', exact: true }).click();
    await expect(page.locator('.xterm-helper-textarea')).toBeVisible();
}

test('Terminal split layout drags, resizes, restores, and preserves the live PTY', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-layout-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    let running = await launch(userData, root);
    try {
        await createShellSession(running.page);
        const firstTerminalId = await running.page.evaluate(async () => {
            const bridge = (
                window as unknown as {
                    caxri: { request<T>(method: string, params?: unknown): Promise<T> };
                }
            ).caxri;
            const state = await bridge.request<{
                terminals: Array<{ id: string }>;
            }>('app.bootstrap');
            return state.terminals[0].id;
        });
        const initialInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-helper-textarea`,
        );
        await initialInput.focus();
        await initialInput.pressSequentially('export CAXRI_SPLIT_CONTINUITY=alive');
        await initialInput.press('Enter');
        await initialInput.pressSequentially('printf "$CAXRI_SPLIT_CONTINUITY\\n"');
        await initialInput.press('Enter');
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('alive');
        await running.page.getByTitle('Split Terminal').click();
        await expect(running.page.locator('.terminal-group')).toHaveCount(2);
        await expect(running.page.getByRole('separator')).toHaveCount(1);
        const runningBeforeMove = await running.page.evaluate(() => {
            const bridge = (
                window as unknown as {
                    caxri: { request<T>(method: string, params?: unknown): Promise<T> };
                }
            ).caxri;
            return bridge.request<number>('terminal.runningCount');
        });

        const dragFirstTab = (targetIndex: number, xRatio: number, yRatio: number) =>
            running.page.evaluate(
                ({ firstTerminalId, targetIndex, xRatio, yRatio }) => {
                    const source = document.querySelector(
                        `.work-tab[data-terminal-id="${firstTerminalId}"]`,
                    );
                    const target = document.querySelectorAll('.terminal-group')[targetIndex];
                    if (!source || !target) throw new Error('Terminal drag fixture not found');
                    const transfer = new DataTransfer();
                    const bounds = target.getBoundingClientRect();
                    const options = {
                        bubbles: true,
                        cancelable: true,
                        clientX: bounds.left + bounds.width * xRatio,
                        clientY: bounds.top + bounds.height * yRatio,
                        dataTransfer: transfer,
                    };
                    source.dispatchEvent(new DragEvent('dragstart', options));
                    target.dispatchEvent(new DragEvent('dragenter', options));
                    target.dispatchEvent(new DragEvent('dragover', options));
                    target.dispatchEvent(new DragEvent('drop', options));
                    source.dispatchEvent(new DragEvent('dragend', options));
                },
                { firstTerminalId, targetIndex, xRatio, yRatio },
            );
        await dragFirstTab(1, 0.5, 0.5);
        await expect(running.page.locator('.terminal-group')).toHaveCount(1);
        await dragFirstTab(0, 0.9, 0.5);
        await expect(running.page.locator('.terminal-group')).toHaveCount(2);

        const firstInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-helper-textarea`,
        );
        await firstInput.focus();
        await firstInput.pressSequentially('printf "$CAXRI_SPLIT_CONTINUITY\\n"');
        await firstInput.press('Enter');
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('alive');
        await expect
            .poll(() =>
                running.page.evaluate(() => {
                    const bridge = (
                        window as unknown as {
                            caxri: { request<T>(method: string, params?: unknown): Promise<T> };
                        }
                    ).caxri;
                    return bridge.request<number>('terminal.runningCount');
                }),
            )
            .toBe(runningBeforeMove);

        const splitter = running.page.getByRole('separator');
        await splitter.focus();
        await running.page.keyboard.press('ArrowRight');
        const savedRatio = await running.page.evaluate(async () => {
            const bridge = (
                window as unknown as {
                    caxri: { request<T>(method: string, params?: unknown): Promise<T> };
                }
            ).caxri;
            const state = await bridge.request<{
                sessionStates: Array<{ layout: { root?: { ratio?: number } } }>;
            }>('app.bootstrap');
            return state.sessionStates[0].layout.root?.ratio;
        });
        expect(savedRatio).toBeCloseTo(0.55, 2);

        await running.app.close();
        running = await launch(userData, root);
        await expect(running.page.locator('.terminal-group')).toHaveCount(2);
        await expect(running.page.getByRole('separator')).toHaveAttribute('aria-valuenow', '55');

        const restoredFirstTab = running.page.locator(
            `.work-tab[data-terminal-id="${firstTerminalId}"]`,
        );
        await restoredFirstTab.hover();
        await restoredFirstTab.locator('.tab-close').click();
        await expect(running.page.locator('.terminal-group')).toHaveCount(1);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
