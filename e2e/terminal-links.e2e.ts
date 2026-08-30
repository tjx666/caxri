import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { execFileAsync } from '@caxri/system';
import type { MessageBoxOptions } from 'electron';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    clickTerminalLink,
    createShellSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
    typeTerminal,
} from './support/helpers.ts';

test('Terminal links open Project files and confirm URLs through Main', async () => {
    allowE2EErrors([
        { source: 'desktop', event: 'ipc.request_failed', code: 'INTERNAL', count: 1 },
        { source: 'desktop', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
        { source: 'server-core', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-links-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const isolatedHome = join(userData, 'e2e-agents', 'home');
    const root = join(isolatedHome, 'project');
    const file = join(root, 'link-target.ts');
    const inferredFile = join(root, 'lobehub', 'apps', 'server', 'message.ts');
    const lineFile = join(root, '.local-config', 'router-runtime.json');
    const rangeFile = join(root, 'doctor.config.jsonc');
    const shortenedFile = join(
        root,
        'packages',
        'runtime',
        'services',
        'artifactDeploymentQuota',
        'index.test.ts',
    );
    const ambiguousAlpha = join(root, 'packages', 'alpha', 'services', 'shared', 'shared.test.ts');
    const ambiguousBeta = join(root, 'packages', 'beta', 'services', 'shared', 'shared.test.ts');
    const outsideRoot = join(isolatedHome, 'outside-project');
    const outsideFile = join(outsideRoot, 'outside-target.ts');
    await Promise.all([
        mkdir(join(root, '.local-config'), { recursive: true }),
        mkdir(dirname(inferredFile), { recursive: true }),
        mkdir(dirname(shortenedFile), { recursive: true }),
        mkdir(dirname(ambiguousAlpha), { recursive: true }),
        mkdir(dirname(ambiguousBeta), { recursive: true }),
        mkdir(outsideRoot, { recursive: true }),
    ]);
    await Promise.all([
        writeFile(file, 'first line\nsecond line\nthird line\n'),
        writeFile(inferredFile, 'export const nestedWorkspaceTarget = true;\n'),
        writeFile(
            lineFile,
            `${Array.from({ length: 40 }, (_, index) => `single-${String(index + 1).padStart(2, '0')}`).join('\n')}\n`,
        ),
        writeFile(
            rangeFile,
            `${Array.from({ length: 30 }, (_, index) => `range-${String(index + 1).padStart(2, '0')}`).join('\n')}\n`,
        ),
        writeFile(shortenedFile, 'unique-1\nunique-2\nunique-3\nunique-4\nunique-5\n'),
        writeFile(ambiguousAlpha, 'alpha-1\nalpha-2\nalpha-3\n'),
        writeFile(ambiguousBeta, 'beta-1\nbeta-2\nbeta-3\n'),
        writeFile(outsideFile, 'outside first\noutside second\n'),
    ]);

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify([root, outsideRoot]) },
    });
    try {
        await createShellSession(running.page);
        const sourceSessionId = await selectedSessionId(running.page);
        const fileLink = 'link-target.ts:2:3';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${fileLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(fileLink);
        await clickTerminalLink(running.page, fileLink);

        await expect(running.page.getByRole('tab', { name: 'link-target.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(running.page.getByLabel(/^Editor position: Ln 2, Col 3/)).toBeVisible();

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        const inferredLink = 'apps/server/message.ts';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${inferredLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(inferredLink);
        await clickTerminalLink(running.page, inferredLink);
        await expect(running.page.getByRole('tab', { name: 'message.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(
            running.page.locator('.monaco-editor').first().locator('.view-lines'),
        ).toContainText('nestedWorkspaceTarget');
        await expect(
            running.page.getByRole('dialog', { name: 'Choose Terminal File' }),
        ).toHaveCount(0);

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        const lineLink = '.local-config/router-runtime.json:32';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${lineLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(lineLink);
        await clickTerminalLink(running.page, lineLink);
        await expect(
            running.page.getByRole('tab', { name: 'router-runtime.json' }),
        ).toHaveAttribute('aria-selected', 'true');
        await expect(
            running.page.getByLabel(/Editor position: .*9 characters selected/),
        ).toBeVisible();
        const lineEditor = running.page.locator('.monaco-editor').first();
        await expect(lineEditor.locator('.view-lines')).toContainText('single-32');
        await expect
            .poll(() => lineEditor.evaluate((element) => element.contains(document.activeElement)))
            .toBe(true);

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        const rangeLink = 'doctor.config.jsonc#L20-21';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${rangeLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(rangeLink);
        await clickTerminalLink(running.page, rangeLink);
        await expect(
            running.page.getByRole('tab', { name: 'doctor.config.jsonc' }),
        ).toHaveAttribute('aria-selected', 'true');
        await expect(
            running.page.getByLabel(/Editor position: .*17 characters selected/),
        ).toBeVisible();
        const rangeEditor = running.page.locator('.monaco-editor').first();
        await expect(rangeEditor.locator('.view-lines')).toContainText('range-20');
        await expect(rangeEditor.locator('.view-lines')).toContainText('range-21');
        await expect
            .poll(() => rangeEditor.evaluate((element) => element.contains(document.activeElement)))
            .toBe(true);

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        const shortenedLink = '.../services/artifactDeploymentQuota/index.test.ts:4:2';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${shortenedLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(shortenedLink);
        await clickTerminalLink(running.page, shortenedLink);
        await expect(running.page.getByRole('tab', { name: 'index.test.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(running.page.getByLabel(/^Editor position: Ln 4, Col 2/)).toBeVisible();

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        const ambiguousLink = '.../services/shared/shared.test.ts:2:3';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${ambiguousLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(ambiguousLink);
        await clickTerminalLink(running.page, ambiguousLink);
        const candidateDialog = running.page.getByRole('dialog', { name: 'Choose Terminal File' });
        await expect(candidateDialog).toBeVisible();
        await expect(candidateDialog.getByRole('option')).toHaveCount(2);
        await running.page.keyboard.press('Escape');
        await expect(candidateDialog).not.toBeAttached();
        await expect(running.page.getByRole('tab', { name: 'Shell' })).toHaveAttribute(
            'aria-selected',
            'true',
        );

        const terminalInput = running.page.locator('.xterm-helper-textarea');
        await terminalInput.focus();
        await running.page.keyboard.press('Meta+Shift+O');
        const detectedLinkDialog = running.page.getByRole('dialog', {
            name: 'Open Detected Link',
        });
        const detectedLinkSearch = detectedLinkDialog.getByPlaceholder(
            'Search links in the Terminal…',
        );
        await detectedLinkSearch.fill(ambiguousLink);
        await detectedLinkSearch.press('Enter');
        await expect(candidateDialog).toBeVisible();
        await expect(candidateDialog.getByRole('option')).toHaveCount(2);
        await candidateDialog.getByPlaceholder('Search matching files…').fill('packages/alpha');
        await expect(candidateDialog.getByRole('option')).toHaveCount(1);
        await running.page.keyboard.press('Enter');
        await expect(running.page.getByRole('tab', { name: 'shared.test.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(running.page.getByLabel(/^Editor position: Ln 2, Col 3/)).toBeVisible();
        await expect(
            running.page.locator('.monaco-editor').first().locator('.view-lines'),
        ).toContainText('alpha-2');

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        const missingLink = '.../services/missing/missing.test.ts:4:2';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${missingLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(missingLink);
        await terminalInput.focus();
        await running.page.keyboard.press('Meta+Shift+O');
        await detectedLinkSearch.fill(missingLink);
        await expect(
            detectedLinkDialog.getByRole('option', {
                name: `Open file link ${missingLink}`,
                exact: true,
            }),
        ).toBeVisible();
        await detectedLinkSearch.press('Enter');
        await expect(running.page.locator('.toast')).toContainText('File not found');
        await expect(running.page.locator('.toast')).not.toContainText('ENOENT');
        await expect(running.page.locator('.toast')).not.toContainText('realpath');
        await running.page.getByLabel('Dismiss notification').click();

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        const existingHomeLink = '~/project/doctor.config.jsonc#L20-L21';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${existingHomeLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(existingHomeLink);
        await clickTerminalLink(running.page, existingHomeLink);
        await expect(
            running.page.getByRole('tab', { name: 'doctor.config.jsonc' }),
        ).toHaveAttribute('aria-selected', 'true');
        await expect(
            running.page.getByLabel(/Editor position: .*17 characters selected/),
        ).toBeVisible();

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        const outsideHomeLink = '~/outside-project/outside-target.ts:2:4';
        await typeTerminal(running.page, String.raw`printf '%s\n' '${outsideHomeLink}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(outsideHomeLink);
        await clickTerminalLink(running.page, outsideHomeLink);
        await expect(running.page.getByRole('tab', { name: 'outside-target.ts' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(running.page.getByLabel(/^Editor position: Ln 2, Col 4/)).toBeVisible();
        await expect(
            running.page.getByRole('treeitem', { name: /outside-project/ }).first(),
        ).toBeVisible();
        await sessionCard(running.page, sourceSessionId).click();
        await expect(running.page.getByRole('tab', { name: 'Shell' })).toBeVisible();

        await running.app.evaluate(({ dialog, shell }) => {
            const target = globalThis as typeof globalThis & {
                caxriExternalLinkProbe?: {
                    confirmations: string[];
                    failOpen: boolean;
                    opened: string[];
                    response: number;
                };
            };
            target.caxriExternalLinkProbe = {
                confirmations: [],
                failOpen: false,
                opened: [],
                response: 0,
            };
            dialog.showMessageBox = (
                windowOrOptions: unknown,
                maybeOptions?: MessageBoxOptions,
            ) => {
                const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
                target.caxriExternalLinkProbe!.confirmations.push(options.message);
                return Promise.resolve({
                    response: target.caxriExternalLinkProbe!.response,
                    checkboxChecked: false,
                });
            };
            shell.openExternal = (url) => {
                if (target.caxriExternalLinkProbe!.failOpen)
                    return Promise.reject(new Error('browser unavailable'));
                target.caxriExternalLinkProbe!.opened.push(url);
                return Promise.resolve();
            };
        });

        await expect(
            pageRequest(running.page, 'external.open', { url: 'not a URL' }),
        ).resolves.toEqual({ status: 'rejected', reason: 'invalid_url' });
        await expect(
            pageRequest(running.page, 'external.open', { url: 'file:///tmp/caxri-denied-link' }),
        ).resolves.toEqual({ status: 'rejected', reason: 'unsupported_protocol' });
        await running.page.evaluate(() => window.open('file:///tmp/caxri-denied-link'));
        const url = 'https://example.com/caxri-link';
        await running.page.getByRole('tab', { name: 'Shell' }).click();
        await typeTerminal(running.page, String.raw`printf '%s\n' '${url}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(url);
        await clickTerminalLink(running.page, url);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriExternalLinkProbe?: { opened: string[] };
                    };
                    return target.caxriExternalLinkProbe?.opened;
                }),
            )
            .toContain(url);
        await expect(running.page.locator('.toast')).toHaveCount(0);

        const cjkBoundaryUrl = 'https://example.com/caxri-cjk-boundary';
        const cjkBoundaryLine = `(${cjkBoundaryUrl}），后续正文`;
        await typeTerminal(running.page, String.raw`printf '%s\n' '${cjkBoundaryLine}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(cjkBoundaryLine);
        await clickTerminalLink(running.page, cjkBoundaryUrl);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriExternalLinkProbe?: { opened: string[] };
                    };
                    return target.caxriExternalLinkProbe?.opened;
                }),
            )
            .toContain(cjkBoundaryUrl);

        const canceledUrl = 'https://example.org/canceled';
        await running.app.evaluate(() => {
            const target = globalThis as typeof globalThis & {
                caxriExternalLinkProbe?: { response: number };
            };
            target.caxriExternalLinkProbe!.response = 2;
        });
        await typeTerminal(running.page, String.raw`printf '%s\n' '${canceledUrl}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(canceledUrl);
        await clickTerminalLink(running.page, canceledUrl);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriExternalLinkProbe?: { confirmations: string[] };
                    };
                    return target.caxriExternalLinkProbe?.confirmations.length;
                }),
            )
            .toBe(3);
        await expect(running.page.locator('.toast')).toHaveCount(0);

        const failedUrl = 'https://example.net/failure';
        await running.app.evaluate(() => {
            const target = globalThis as typeof globalThis & {
                caxriExternalLinkProbe?: { failOpen: boolean; response: number };
            };
            target.caxriExternalLinkProbe!.response = 0;
            target.caxriExternalLinkProbe!.failOpen = true;
        });
        await typeTerminal(running.page, String.raw`printf '%s\n' '${failedUrl}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(failedUrl);
        await clickTerminalLink(running.page, failedUrl);
        await expect(running.page.locator('.toast')).toContainText('browser unavailable');
        await expect(running.page.locator('.toast')).not.toContainText('Popup blocked');

        await expect(
            running.app.evaluate(() => {
                const target = globalThis as typeof globalThis & {
                    caxriExternalLinkProbe?: {
                        confirmations: string[];
                        opened: string[];
                    };
                };
                return target.caxriExternalLinkProbe;
            }),
        ).resolves.toMatchObject({
            confirmations: [
                'Open example.com in your default browser?',
                'Open example.com in your default browser?',
                'Open example.org in your default browser?',
                'Open example.net in your default browser?',
            ],
            opened: [url, cjkBoundaryUrl],
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Terminal references open configured issues and an authorized Git commit', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-references-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: root });
    await writeFile(join(root, 'first.txt'), 'first\n', 'utf8');
    await execFileAsync('git', ['add', 'first.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'first reference commit'], { cwd: root });
    const sha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await writeFile(join(root, 'second.txt'), 'second\n', 'utf8');
    await execFileAsync('git', ['add', 'second.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'latest commit'], { cwd: root });
    await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:tjx666/caxri.git'], {
        cwd: root,
    });
    let shortShaLength = 7;
    while (!/[a-f]/.test(sha.slice(0, shortShaLength))) shortShaLength += 1;
    const shortSha = sha.slice(0, shortShaLength);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await running.page.keyboard.press('Meta+,');
        const settings = running.page.getByRole('dialog');
        await settings.getByLabel('Search settings').fill('reference links');
        const editor = settings.getByRole('region', {
            name: 'Terminal Reference Links editor',
        });
        await editor.getByLabel('Reference title').fill('Linear issue');
        await editor.getByLabel('Reference prefix').fill('LOBE-');
        await editor.getByLabel('Reference URL template').fill('javascript:alert(<num>)');
        await editor.getByRole('button', { name: 'Add', exact: true }).click();
        await expect(editor.getByRole('alert')).toContainText(
            'Expected an HTTP(S) URL containing <num> and no credentials',
        );
        await editor
            .getByLabel('Reference URL template')
            .fill('https://linear.app/lobehub/issue/<num>');
        await editor.getByRole('button', { name: 'Add', exact: true }).click();
        await expect(
            editor.getByRole('list', { name: 'Terminal reference link rules' }),
        ).toContainText('LOBE-');
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: { 'terminal.referenceLinks': Array<{ prefix: string }> };
                }>(running.page, 'settings.get');
                return result.value['terminal.referenceLinks'].map(({ prefix }) => prefix);
            })
            .toEqual(['LOBE-']);
        await settings.getByRole('button', { name: 'Close' }).click();

        await running.app.evaluate(({ dialog, shell }) => {
            const target = globalThis as typeof globalThis & {
                caxriReferenceProbe?: { opened: string[] };
            };
            target.caxriReferenceProbe = { opened: [] };
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
            shell.openExternal = (url) => {
                target.caxriReferenceProbe!.opened.push(url);
                return Promise.resolve();
            };
        });

        const output = `原有 LOBE-13468 也已补了一条范围说明。GitHub #439; commit ${shortSha}`;
        await typeTerminal(running.page, String.raw`printf '%s\n' '${output}'`);
        await expect(running.page.locator('.xterm-rows')).toContainText(output);

        await clickTerminalLink(running.page, 'LOBE-13468');
        await clickTerminalLink(running.page, '#439');
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriReferenceProbe?: { opened: string[] };
                    };
                    return target.caxriReferenceProbe?.opened;
                }),
            )
            .toEqual([
                'https://linear.app/lobehub/issue/13468',
                'https://github.com/tjx666/caxri/issues/439',
            ]);

        await clickTerminalLink(running.page, shortSha);
        const gitTab = running.page.getByRole('tab', { name: 'Git', exact: true });
        await expect(gitTab).toHaveClass(/active/);
        await expect(
            running.page.getByRole('button', {
                name: `Commit Changes (${sha.slice(0, 7)})`,
            }),
        ).toHaveAttribute('aria-pressed', 'true');
        await expect(running.page.locator('.git-repository-section')).toContainText(
            'first reference commit',
        );
        await expect(running.page.locator('.git-repository-section')).toContainText('first.txt');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Terminal detected-link picker opens file and OSC 8 links without a pointer', async () => {
    allowE2EErrors([
        { source: 'desktop', event: 'ipc.request_failed', code: 'PATH_DENIED', count: 1 },
        { source: 'server-core', event: 'ipc.request_failed', code: 'PATH_DENIED', count: 1 },
        { source: 'desktop', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
        { source: 'server-core', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-link-picker-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const isolatedHome = join(userData, 'e2e-agents', 'home');
    const root = join(isolatedHome, 'project');
    const file = join(root, 'link-target.ts');
    const rangeFile = join(root, 'doctor.config.jsonc');
    const deniedFile = join(testDirectory, 'denied-target.ts');
    await mkdir(root, { recursive: true });
    await Promise.all([
        writeFile(file, 'first line\nsecond line\nthird line\n'),
        writeFile(
            rangeFile,
            `${Array.from({ length: 30 }, (_, index) => `range-${String(index + 1).padStart(2, '0')}`).join('\n')}\n`,
        ),
        writeFile(deniedFile, 'outside Project root\n'),
    ]);

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify([root]) },
    });
    try {
        await createShellSession(running.page);
        await running.app.evaluate(({ dialog, shell }) => {
            const target = globalThis as typeof globalThis & {
                caxriKeyboardLinkProbe?: {
                    confirmations: string[];
                    opened: string[];
                    response: number;
                };
            };
            target.caxriKeyboardLinkProbe = { confirmations: [], opened: [], response: 0 };
            dialog.showMessageBox = (
                windowOrOptions: unknown,
                maybeOptions?: MessageBoxOptions,
            ) => {
                const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
                target.caxriKeyboardLinkProbe!.confirmations.push(options.message);
                return Promise.resolve({
                    response: target.caxriKeyboardLinkProbe!.response,
                    checkboxChecked: false,
                });
            };
            shell.openExternal = (url) => {
                target.caxriKeyboardLinkProbe!.opened.push(url);
                return Promise.resolve();
            };
        });

        const fileLink = 'link-target.ts:2:3';
        const rangeLink = 'doctor.config.jsonc#L20-L21';
        const invalidRangeLink = 'doctor.config.jsonc#L21-20';
        const homeLink = '~/project/link-target.ts:3:2';
        const url = 'https://example.org/keyboard-link#L20-L21';
        const rejectedUrl = 'https://user:password@example.net/rejected';
        const oscTargetSuffix = 'osc-keyboard-link?q=你好，世界';
        const oscUrl = `https://example.com/${oscTargetSuffix}`;
        const openedOscUrl = new URL(oscUrl).href;
        const cjkBoundaryUrl = 'https://example.com/caxri-cjk-boundary';
        const cjkBoundaryLine = `(${cjkBoundaryUrl}），后续正文`;
        const oscPrefix = `OSC reflow prefix ${'x'.repeat(180)}`;
        await typeTerminal(
            running.page,
            String.raw`printf '%s\n' '${fileLink}' '${rangeLink}' '${invalidRangeLink}' '${homeLink}' '${url}' '${rejectedUrl}' '${cjkBoundaryLine}'; printf '%s\033]8;;https://example.com/%s\007OSC link label\033]8;;\007\n' '${oscPrefix}' '${oscTargetSuffix}'`,
        );
        const terminalInput = running.page.locator('.xterm-helper-textarea');
        await expect(running.page.locator('.xterm-rows')).toContainText('OSC link label');

        const openLink = async (target: string, accessibleName: string): Promise<void> => {
            await terminalInput.focus();
            await running.page.keyboard.press('Meta+Shift+O');
            const dialog = running.page.getByRole('dialog');
            await expect(dialog.getByRole('heading', { name: 'Open Detected Link' })).toBeVisible();
            const search = dialog.getByPlaceholder('Search links in the Terminal…');
            await search.fill(target);
            await expect(
                dialog.getByRole('option', { name: accessibleName, exact: true }),
            ).toBeVisible();
            await search.press('Enter');
            await expect(dialog).toHaveCount(0);
        };
        const printTerminalLink = async (target: string): Promise<void> => {
            const midpoint = Math.floor(target.length / 2);
            /**
             * Keep the full target out of the echoed command so this assertion can only pass after the shell emits the
             * completed command's output, not during its transient editable-line redraw.
             */
            await typeTerminal(
                running.page,
                String.raw`printf '%s%s\n' '${target.slice(0, midpoint)}' '${target.slice(midpoint)}'`,
            );
            await expect(running.page.locator('.xterm-rows')).toContainText(target);
        };

        await terminalInput.focus();
        await running.page.keyboard.press('Meta+Shift+O');
        await running.page.keyboard.press('Escape');
        await expect(terminalInput).toBeFocused();

        await running.page.keyboard.press('Meta+Shift+O');
        const invalidDialog = running.page.getByRole('dialog');
        await invalidDialog
            .getByPlaceholder('Search links in the Terminal…')
            .fill(invalidRangeLink);
        await expect(
            invalidDialog.getByRole('option', {
                name: `Open file link ${invalidRangeLink}`,
                exact: true,
            }),
        ).toHaveCount(0);
        await running.page.keyboard.press('Escape');
        await expect(terminalInput).toBeFocused();

        await openLink(oscUrl, `Open external link ${oscUrl}`);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriKeyboardLinkProbe?: { opened: string[] };
                    };
                    return target.caxriKeyboardLinkProbe?.opened;
                }),
            )
            .toContain(openedOscUrl);

        await openLink(cjkBoundaryUrl, `Open external link ${cjkBoundaryUrl}`);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriKeyboardLinkProbe?: { opened: string[] };
                    };
                    return target.caxriKeyboardLinkProbe?.opened;
                }),
            )
            .toContain(cjkBoundaryUrl);

        await running.app.evaluate(() => {
            const target = globalThis as typeof globalThis & {
                caxriKeyboardLinkProbe?: { response: number };
            };
            target.caxriKeyboardLinkProbe!.response = 2;
        });
        await openLink(url, `Open external link ${url}`);
        await expect(terminalInput).toBeFocused();
        await openLink(rejectedUrl, `Open external link ${rejectedUrl}`);
        await expect(running.page.locator('.toast')).toContainText(
            'External links cannot include credentials',
        );
        await expect(terminalInput).toBeFocused();
        await expect(
            running.app.evaluate(() => {
                const target = globalThis as typeof globalThis & {
                    caxriKeyboardLinkProbe?: {
                        confirmations: string[];
                        opened: string[];
                    };
                };
                return target.caxriKeyboardLinkProbe;
            }),
        ).resolves.toMatchObject({
            confirmations: [
                'Open example.com in your default browser?',
                'Open example.com in your default browser?',
                'Open example.org in your default browser?',
            ],
            opened: [openedOscUrl, cjkBoundaryUrl],
        });

        await openLink(rangeLink, `Open file link ${rangeLink}`);
        await expect(
            running.page.getByRole('tab', { name: 'doctor.config.jsonc' }),
        ).toHaveAttribute('aria-selected', 'true');
        await expect(
            running.page.getByLabel(/Editor position: .*17 characters selected/),
        ).toBeVisible();
        const editor = running.page.locator('.monaco-editor').first();
        await expect(editor.locator('.view-lines')).toContainText('range-20');
        await expect(editor.locator('.view-lines')).toContainText('range-21');
        await expect
            .poll(() => editor.evaluate((element) => element.contains(document.activeElement)))
            .toBe(true);

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        await typeTerminal(
            running.page,
            String.raw`printf '\033[?1049hALTERNATE SCREEN DURING REMOUNT'`,
        );
        await expect(running.page.locator('.xterm-rows')).toContainText(
            'ALTERNATE SCREEN DURING REMOUNT',
        );
        await running.page.getByRole('tab', { name: 'doctor.config.jsonc' }).click();
        await running.page.getByRole('tab', { name: 'Shell' }).click();
        await expect(running.page.locator('.xterm-rows')).toContainText(
            'ALTERNATE SCREEN DURING REMOUNT',
        );
        const terminalWidthBeforeResize = await running.page
            .locator('.xterm-screen')
            .evaluate((element) => element.getBoundingClientRect().width);
        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.setBounds({ width: 720, height: 640 }),
        );
        await expect
            .poll(() =>
                running.page
                    .locator('.xterm-screen')
                    .evaluate((element) => element.getBoundingClientRect().width),
            )
            .toBeLessThan(terminalWidthBeforeResize);
        await typeTerminal(running.page, String.raw`printf '\033[?1049l'`);
        await expect(running.page.locator('.xterm-rows')).toContainText('OSC link label');
        await running.app.evaluate(() => {
            const target = globalThis as typeof globalThis & {
                caxriKeyboardLinkProbe?: { response: number };
            };
            target.caxriKeyboardLinkProbe!.response = 0;
        });
        await openLink(oscUrl, `Open external link ${oscUrl}`);
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const target = globalThis as typeof globalThis & {
                        caxriKeyboardLinkProbe?: { opened: string[] };
                    };
                    return target.caxriKeyboardLinkProbe?.opened;
                }),
            )
            .toEqual([openedOscUrl, cjkBoundaryUrl, openedOscUrl]);
        await openLink(homeLink, `Open file link ${homeLink}`);
        await expect(running.page.getByLabel(/^Editor position: Ln 3, Col 2/)).toBeVisible();

        await running.page.getByRole('tab', { name: 'Shell' }).click();
        const beforeRejectedLinks = await pageRequest<{
            projects: unknown[];
            sessions: unknown[];
        }>(running.page, 'app.bootstrap');
        const deniedLink = deniedFile;
        await printTerminalLink(deniedLink);
        await openLink(deniedLink, `Open file link ${deniedLink}`);
        await expect(
            running.page
                .locator('.toast')
                .filter({ hasText: 'Terminal link target is outside every Project' }),
        ).toBeVisible();
        await expect(terminalInput).toBeFocused();

        const missingLink = '~/project/missing-target.ts';
        await printTerminalLink(missingLink);
        await openLink(missingLink, `Open file link ${missingLink}`);
        await expect(
            running.page.locator('.toast').filter({ hasText: 'File not found' }),
        ).toBeVisible();
        await expect(terminalInput).toBeFocused();
        const afterRejectedLinks = await pageRequest<{
            projects: unknown[];
            sessions: unknown[];
        }>(running.page, 'app.bootstrap');
        expect(afterRejectedLinks.projects).toHaveLength(beforeRejectedLinks.projects.length);
        expect(afterRejectedLinks.sessions).toHaveLength(beforeRejectedLinks.sessions.length);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
