import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    mobileNativeControlBounds,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import type { PreviewServer } from './mobile-session-preview-scenario';
import {
    SERVER_SCRIPT,
    SERVER_SOURCE,
    startPreviewServer,
} from './mobile-session-preview-scenario';

/**
 * Waits until a native text node reads `text`, then returns, so a screenshot taken next shows it. The Toast lasts about
 * three seconds, so the caller captures straight after.
 */
const waitForNativeText = (serial: string, text: string) =>
    waitForMobile(
        () => mobileNativeControlBounds(serial, { text }),
        (bounds) => bounds !== null,
        8_000,
    );

/**
 * `MOB-CHAT-TOAST-01`: result feedback arrives as one transient Toast, never a system dialog. Copy link in the in-app
 * browser's menu answers `Link copied`; tapping the preview chip after its server stopped answers `Couldn't open the
 * preview` with the reason beneath it, over the dark app and without a system alert.
 */
export async function executeMobileToastScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    let script = '';
    const servers: PreviewServer[] = [];
    const mobile = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
        seedProject: async (projectRoot) => {
            script = join(projectRoot, SERVER_SCRIPT);
            await writeFile(script, SERVER_SOURCE, 'utf8');
        },
    });
    try {
        if (!mobile.allowedSessionId) throw new Error('Toast fixture is unavailable');
        const inside = await startPreviewServer(script, dirname(script));
        servers.push(inside);
        await mobile.pair();
        await tapMobileCheck(serial, `session-row-${mobile.allowedSessionId}`);
        await waitForCheck(serial, 'preview-chip', 60_000);
        await tapMobileCheck(serial, 'preview-chip');
        await waitForCheck(serial, 'in-app-browser');
        await tapMobileCheckByBounds(serial, 'in-app-browser-menu');
        await waitForCheck(serial, 'in-app-browser-copy');
        await tapMobileCheckByBounds(serial, 'in-app-browser-copy');
        if (!(await waitForNativeText(serial, 'Link copied')))
            throw new Error('Copy link did not show a Toast');
        await capture(environment, 'link-copied', artifacts);

        await tapMobileCheckByBounds(serial, 'in-app-browser-close');
        await waitForNoCheck(serial, 'in-app-browser');
        // The chip outlives its server for up to one poll, so a tap right after the stop reaches the failure path.
        await waitForCheck(serial, 'preview-chip');
        const stopped = inside.stop();
        await tapMobileCheck(serial, 'preview-chip');
        await stopped;
        if (!(await waitForNativeText(serial, "Couldn't open the preview")))
            throw new Error('A failed preview did not show a Toast');
        await capture(environment, 'preview-failed', artifacts);
        await finish(environment, artifacts, {
            linkCopied: 'toast',
            previewFailed: 'toast-without-system-dialog',
            status: 'passed',
        });
    } finally {
        await Promise.all(servers.map((server) => server.stop()));
        await mobile.stop();
    }
}
