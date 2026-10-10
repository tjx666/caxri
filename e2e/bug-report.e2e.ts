import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

/**
 * The screenshot `alt` text has to say that a screenshot, unlike the text report, is captured pixel-for-pixel and
 * cannot be redacted. Pinned here as a constant so a future copy edit that quietly drops the disclosure fails this spec
 * instead of passing silently.
 */
const SCREENSHOT_PREVIEW_ALT =
    'Unredacted screenshot of the current Caxri window, including any open files and terminal output';

test('Bug report preview sends one redacted multiline prompt to the selected live Agent', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-bug-report-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capture = join(testDirectory, 'agent-input.bin');
    await Promise.all([mkdir(root, { recursive: true }), writeFile(capture, '')]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                inputCapture: { path: capture, encoding: 'raw' },
                readinessDelayMs:
                    process.env.CAXRI_CI_PARITY_CASE === 'late-raw-mode' ? 750 : undefined,
                startupOutput: 'FAKE_CLAUDE_INPUT_READY\r\n',
            },
        },
    });

    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page, 'claude');
        await expect(running.page.locator('.xterm-rows')).toContainText('FAKE_CLAUDE_INPUT_READY');
        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        await palette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('report bug');
        await palette.getByText('Report Bug to Agent', { exact: true }).click();

        const dialog = running.page.getByRole('dialog');
        // The dialog spends the automatic capture hidden, which makes Base UI's initial-focus pass
        // a no-op; `BugReportForm` re-claims focus once the capture is over. Asserted in real
        // Electron because a hidden subtree's focus behavior is exactly what a stub would fake.
        await expect(dialog.getByLabel('Actual behavior')).toBeFocused();
        await dialog
            .getByLabel('Actual behavior')
            .fill('The action failed with token=private-value.');
        await dialog.getByLabel('Expected behavior').fill('The action should finish once.');
        await dialog
            .getByLabel('Reproduction steps')
            .fill('1. Open Caxri\n2. Run the action\n3. Observe the failure');
        // The screenshot is captured automatically on open, and the form must immediately admit
        // that it is the one part of the report that is *not* redacted; the assertions below
        // prove the text half still is.
        await expect(dialog.getByAltText(SCREENSHOT_PREVIEW_ALT)).toBeVisible();
        await expect(dialog).toContainText(
            'Unlike the text report, this screenshot is not redacted',
        );

        // Mark one area of the screenshot and describe it.
        await dialog.locator('#bug-report-annotate').click();
        const annotator = running.page.locator('[data-bug-report-annotator]');
        const surface = annotator.getByRole('application');
        await expect(surface).toBeVisible();
        const box = await surface.boundingBox();
        if (!box) throw new Error('Annotation surface has no bounding box');
        await running.page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
        await running.page.mouse.down();
        await running.page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4, {
            steps: 5,
        });
        await running.page.mouse.up();
        const note = annotator.locator('#bug-report-annotation-note-0');
        await expect(note).toBeFocused();
        await note.fill('This button is misaligned');
        await annotator.locator('#bug-report-annotator-done').click();
        await expect(annotator).toHaveCount(0);
        await expect(dialog).toContainText('1 annotation');
        await dialog.getByRole('button', { name: 'Preview Report' }).click();

        const preview = dialog.locator('pre');
        await expect(preview).toContainText('# Caxri Bug Report');
        await expect(preview).toContainText('token=[REDACTED]');
        await expect(preview).not.toContainText('private-value');
        await expect(dialog.getByAltText(SCREENSHOT_PREVIEW_ALT)).toBeVisible();
        await expect(preview).toContainText('## Screenshot');
        await expect(preview).toContainText('caxri-bug-reports/caxri-bug-report-');
        await expect(preview).toContainText('1. [box x=');
        await expect(preview).toContainText('This button is misaligned');
        await expect(dialog.getByLabel('Target Agent')).toContainText('Claude');

        await dialog.getByRole('button', { name: 'Send to Agent' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(running.page.getByText(/Bug report sent to/)).toBeVisible();

        let agentInput = '';
        await expect
            .poll(async () => {
                agentInput = await readFile(capture, 'utf8');
                return agentInput.endsWith('\u{1B}[201~\r');
            })
            .toBe(true);
        expect(agentInput.startsWith('\u{1B}[200~# Caxri Bug Report')).toBe(true);
        expect(agentInput).toContain('The action failed with token=[REDACTED]');
        expect(agentInput).toContain('1. Open Caxri\n2. Run the action\n3. Observe the failure');
        expect(agentInput).toContain('This button is misaligned');
        expect(agentInput).not.toContain('private-value');
        const screenshotPath = /- File: `([^`]+)`/.exec(agentInput)?.[1];
        expect(screenshotPath).toBeDefined();
        const savedScreenshot = await readFile(screenshotPath!);
        // JPEG SOI marker: the Agent must be able to open the referenced file as an image.
        expect(savedScreenshot.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        await rm(screenshotPath!, { force: true });
        expect(agentInput.split('\u{1B}[200~')).toHaveLength(2);
        expect(agentInput.split('\u{1B}[201~')).toHaveLength(2);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Bug report delivers an opted-in screenshot through Codex image paste', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-bug-report-codex-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const capture = join(testDirectory, 'agent-input.bin');
    await Promise.all([mkdir(root), writeFile(capture, '')]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                inputCapture: { path: capture, encoding: 'raw' },
                startupOutput: 'FAKE_CODEX_INPUT_READY\r\n',
            },
        },
    });

    const running = await launchCaxri({
        agentMode,
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });
    /**
     * The saved screenshot lives in the OS temp directory, outside `testDirectory`, so it has to be removed by path.
     */
    let screenshotPath: string | undefined;
    try {
        await createProjectSession(running.page, 'codex');
        await expect(running.page.locator('.xterm-rows')).toContainText('FAKE_CODEX_INPUT_READY');
        // The default `Cmd+Shift+B` chord must reach the command while the Terminal owns focus.
        await running.page.keyboard.press('Meta+Shift+B');

        const dialog = running.page.locator('[data-bug-report-dialog]');
        await expect(dialog).toBeVisible();
        await dialog.getByLabel('Actual behavior').fill('The preview is stale.');
        await dialog.getByLabel('Expected behavior').fill('The preview should refresh.');
        // Reproduction steps are optional: leave them empty.
        await expect(dialog).toContainText('sending replaces the system clipboard');
        await dialog.getByRole('button', { name: 'Preview Report' }).click();
        await expect(dialog.getByAltText(SCREENSHOT_PREVIEW_ALT)).toBeVisible();
        await expect(dialog.locator('pre')).not.toContainText('## Reproduction steps');
        const previewText = (await dialog.locator('pre').textContent()) ?? '';
        screenshotPath = /- File: `([^`]+)`/.exec(previewText)?.[1];
        expect(screenshotPath).toBeDefined();

        await dialog.getByRole('button', { name: 'Send to Agent' }).click();
        await expect(dialog).toHaveCount(0);
        await expect.poll(() => running.clipboard.hasImage()).toBe(true);
        await running.clipboard.claimImage();
        let agentInput = '';
        await expect
            .poll(async () => {
                agentInput = await readFile(capture, 'utf8');
                return agentInput.endsWith('\u{1B}[201~\r');
            })
            .toBe(true);
        expect(agentInput.startsWith('\u{16}\u{1B}[200~# Caxri Bug Report')).toBe(true);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        if (screenshotPath) await rm(screenshotPath, { force: true });
        await rm(testDirectory, { recursive: true, force: true });
    }
});
