import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import {
    adbShell,
    androidBounds,
    mobileRegionFingerprint,
    mobileSemantics,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import type { Environment } from './mobile-project-panels-scenarios';
import { capture, finish, hasCheck } from './mobile-project-panels-scenarios';
import { openSessionSidePanel } from './mobile-session-panel';

/**
 * Folders deep and long enough that the breadcrumb above a file overflows a phone's width, so it must scroll.
 */
const DEEP_PREVIEW_FOLDERS = ['packages', 'provider-protocol-conversion', 'src'] as const;

/**
 * A TypeScript source just under the 48 KiB mobile read limit and dense in highlighted tokens, the shape of the file a
 * real preview crashed the app on.
 */
function denseTypeScriptSource(): string {
    const lines: string[] = [];
    for (let index = 0; new TextEncoder().encode(lines.join('\n')).length < 46 * 1_024; index += 1)
        lines.push(
            `export const field${index}: Record<string, number | string> = { a: ${index}, b: '${index}', c: [1, 2, 3] };`,
        );
    return lines.join('\n');
}

/**
 * Opens a dense file under a deep folder path, then drags its breadcrumb toward the start. The app must stay in the
 * foreground with the highlighted preview shown, and the drag must move the breadcrumb.
 */
export async function executeMobileFilesPreviewScenario(
    environment: Environment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'launch-failure',
        serial: environment.serial,
    });
    try {
        const folder = join(fixture.testDirectory, 'allowed-project', ...DEEP_PREVIEW_FOLDERS);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'anthropic.ts'), denseTypeScriptSource(), 'utf8');
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('The allowed Session is unavailable');
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await openSessionSidePanel(environment.serial, 'caxri.files');
        for (const name of [...DEEP_PREVIEW_FOLDERS, 'anthropic.ts']) {
            // eslint-disable-next-line no-await-in-loop -- each folder opens before its child is listed.
            await waitForMobile(
                () => mobileSemantics(environment.serial),
                (nodes) => hasCheck(nodes, `files-entry-${name}`),
            );
            // eslint-disable-next-line no-await-in-loop -- see above.
            await tapMobileCheck(environment.serial, `files-entry-${name}`);
        }
        const preview = await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                hasCheck(nodes, 'files-preview-text') ||
                hasCheck(nodes, 'files-preview-error') ||
                hasCheck(nodes, 'files-preview-unavailable'),
            60_000,
        );
        if (!hasCheck(preview, 'files-preview-text'))
            throw new Error('The dense file did not open as a highlighted preview');
        await capture(environment, 'dense-preview', artifacts);
        const trail = androidBounds(
            preview.find(({ checkId }) => checkId === 'files-breadcrumb')?.bounds ?? '',
        );
        if (!trail) throw new Error('The file breadcrumb is not on screen');
        const before = await mobileRegionFingerprint(environment.serial, trail);
        const y = String(Math.floor((trail.top + trail.bottom) / 2));
        await adbShell(environment.serial, [
            'input',
            'swipe',
            String(trail.left + 20),
            y,
            String(trail.right - 20),
            y,
            '400',
        ]);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => hasCheck(nodes, 'files-breadcrumb'),
        );
        const after = await mobileRegionFingerprint(environment.serial, trail);
        await capture(environment, 'breadcrumb-scrolled', artifacts);
        const isScrolled = before !== after;
        await finish(environment, artifacts, {
            breadcrumbScrolled: isScrolled,
            previewShown: true,
            status: isScrolled ? 'passed' : 'failed',
        });
        if (!isScrolled) throw new Error('Dragging the file breadcrumb did not scroll it');
    } finally {
        await fixture.stop();
    }
}
