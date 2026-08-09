import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type Page } from '@playwright/test';

import { createProjectSession, launchCaxri } from './helpers.ts';

const execFileAsync = promisify(execFile);

interface MotionSample {
    duration: string;
    easing: string;
    kind: string;
    phase: string;
}

async function startMotionCapture(page: Page): Promise<void> {
    await page.evaluate(() => {
        const samples: MotionSample[] = [];
        const capture = (element: Element): void => {
            if (!(element instanceof HTMLElement)) return;
            if (element.matches('.work-tab[data-motion]')) {
                const style = getComputedStyle(element);
                samples.push({
                    duration: style.animationDuration,
                    easing: style.animationTimingFunction,
                    kind: 'tab',
                    phase: element.dataset.motion ?? '',
                });
            }
            if (element.matches('.disclosure-motion[data-motion]')) {
                const style = getComputedStyle(element);
                samples.push({
                    duration: style.transitionDuration,
                    easing: style.transitionTimingFunction,
                    kind: element.dataset.disclosure ?? '',
                    phase: element.dataset.expanded === 'true' ? 'expand' : 'collapse',
                });
            }
        };
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                if (record.type === 'attributes' && record.target instanceof Element)
                    capture(record.target);
                for (const node of record.addedNodes) {
                    if (!(node instanceof Element)) continue;
                    capture(node);
                    for (const element of node.querySelectorAll(
                        '.work-tab[data-motion], .disclosure-motion[data-motion]',
                    ))
                        capture(element);
                }
            }
        });
        observer.observe(document.body, {
            attributeFilter: ['data-expanded', 'data-motion'],
            attributes: true,
            childList: true,
            subtree: true,
        });
        Object.assign(window, { __caxriMotionCapture: { observer, samples } });
    });
}

async function motionSamples(page: Page): Promise<MotionSample[]> {
    return page.evaluate(
        () =>
            (
                window as unknown as {
                    __caxriMotionCapture: { samples: MotionSample[] };
                }
            ).__caxriMotionCapture.samples,
    );
}

async function expectMotion(page: Page, expected: MotionSample): Promise<void> {
    await expect
        .poll(async () =>
            (await motionSamples(page)).some(
                (sample) =>
                    sample.kind === expected.kind &&
                    sample.phase === expected.phase &&
                    sample.duration === expected.duration &&
                    sample.easing === expected.easing,
            ),
        )
        .toBe(true);
}

async function settleMediaPreference(page: Page): Promise<void> {
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
}

test('Project disclosures and work tabs use restrained, reduced-motion-aware timing', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-motion-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const projectDisclosure = running.page.locator('.project-session-disclosure');
        const projectDisclosureButton = running.page.locator('.project-disclosure');
        const initialTab = running.page.locator('.work-tab[data-terminal-id]').first();
        await expect(projectDisclosure).toHaveAttribute('data-expanded', 'true');
        await expect(projectDisclosureButton).toHaveAttribute('aria-expanded', 'true');
        const controlledDisclosureId = await projectDisclosureButton.getAttribute('aria-controls');
        expect(controlledDisclosureId).toBeTruthy();
        await expect(projectDisclosure).toHaveAttribute('id', controlledDisclosureId!);
        await expect(projectDisclosure).not.toHaveAttribute('data-motion');
        await expect(initialTab).not.toHaveAttribute('data-motion');

        await startMotionCapture(running.page);
        await projectDisclosureButton.click();
        await expect(projectDisclosure).toHaveAttribute('data-expanded', 'false');
        await expect(projectDisclosureButton).toHaveAttribute('aria-expanded', 'false');
        await expectMotion(running.page, {
            duration: '0.13s',
            easing: 'ease-in',
            kind: 'project',
            phase: 'collapse',
        });
        await projectDisclosureButton.click();
        await expect(projectDisclosureButton).toHaveAttribute('aria-expanded', 'true');
        await expectMotion(running.page, {
            duration: '0.18s',
            easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
            kind: 'project',
            phase: 'expand',
        });

        await running.page.getByRole('button', { name: 'New Terminal', exact: true }).click();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);
        await expectMotion(running.page, {
            duration: '0.14s',
            easing: 'ease-out',
            kind: 'tab',
            phase: 'enter',
        });
        const addedTab = running.page.locator('.work-tab[data-terminal-id]').last();
        await addedTab.hover();
        await addedTab.getByRole('button', { name: 'Close Terminal' }).click();
        await expectMotion(running.page, {
            duration: '0.11s',
            easing: 'ease-in',
            kind: 'tab',
            phase: 'exit',
        });
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(1);

        const normalMotionSampleCount = (await motionSamples(running.page)).length;
        await running.page.emulateMedia({ reducedMotion: 'reduce' });
        await settleMediaPreference(running.page);
        await running.page.getByRole('button', { name: 'New Terminal', exact: true }).click();
        const reducedTab = running.page.locator('.work-tab[data-terminal-id]').last();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(2);
        await expect(reducedTab).not.toHaveAttribute('data-motion');
        await reducedTab.hover();
        await reducedTab.getByRole('button', { name: 'Close Terminal' }).click();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(1);
        expect(
            (await motionSamples(running.page))
                .slice(normalMotionSampleCount)
                .filter((sample) => sample.kind === 'tab')
                .every((sample) => sample.duration === '0s'),
        ).toBe(true);
        await running.page.emulateMedia({ reducedMotion: 'no-preference' });
        await settleMediaPreference(running.page);

        const session = running.page.locator('.session-row').first();
        await session.hover();
        await session.getByRole('button', { name: /^Archive / }).click();
        const archiveDisclosure = running.page.locator('[data-disclosure="archive"]');
        await expect(archiveDisclosure).not.toHaveAttribute('data-motion');
        await running.page.getByRole('button', { name: /^Archived/ }).click();
        await expectMotion(running.page, {
            duration: '0.18s',
            easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
            kind: 'archive',
            phase: 'expand',
        });

        await running.page.emulateMedia({ reducedMotion: 'reduce' });
        await running.page.getByRole('button', { name: /^Archived/ }).click();
        await expectMotion(running.page, {
            duration: '0s',
            easing: 'ease-in',
            kind: 'archive',
            phase: 'collapse',
        });
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
