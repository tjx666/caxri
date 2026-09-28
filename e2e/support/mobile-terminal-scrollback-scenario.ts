import { expect } from './fixtures';
import { pageRequest } from './helpers';
import {
    adbShell,
    androidBounds,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import { createMobileTerminalAcceptanceFixture } from './mobile-terminal-acceptance-fixture';
import type { Environment } from './mobile-terminal-scenarios';
import { prepareMobileTerminalFixture } from './mobile-terminal-scenarios';

/**
 * How many lines the fake Agent prints on the primary screen (see the `s` input in
 * `mobile-terminal-acceptance-fixture.ts`). It must exceed the tallest phone Terminal row count by a wide margin so a
 * single downward swipe always has real earlier content to reveal, and the two files must be kept in sync by hand --
 * they run in separate processes and cannot share a constant.
 */
export const SCROLLBACK_LINE_COUNT = 150;

/**
 * The exact text one primary-screen scrollback line renders as. Deterministic and numbered so a captured frame can be
 * matched back to its position in the synthetic history instead of relying on screenshot inspection alone.
 */
export const scrollbackLineLabel = (index: number): string =>
    `Scrollback line ${String(index).padStart(4, '0')}`;

/**
 * True once a rendered Terminal frame shows a line from strictly before `beforeIndex` in the synthetic scrollback --
 * i.e. the swipe under test revealed genuinely earlier output, not just a UI affordance change with the same content
 * still on screen.
 */
export const hasEarlierLine = (renderedLines: readonly string[], beforeIndex: number): boolean =>
    renderedLines.some((line) => {
        const match = /^Scrollback line (\d+)$/u.exec(line.trim());
        return match !== null && Number(match[1]) < beforeIndex;
    });

/**
 * MOB-TERM-SCROLLBACK-01 (#1272): PR #1267 (#1264) added touch scroll and inertia for the mobile Terminal WebView's
 * primary-screen `.xterm-viewport`. Every existing Android Acceptance swipe (MOB-TERM-01, MOB-TERM-SCROLL-FEEL-01)
 * instead drives a full-screen alternate-screen Agent, which keeps no xterm scrollback and forwards drags as SGR
 * mouse-wheel input to the Agent process -- see the comment above the fullscreen swipe in
 * `mobile-terminal-scenarios.ts`. This scenario stays on the primary screen so its swipe exercises the real
 * `.xterm-viewport` touch handler instead, which until now only Playwright's browser-level
 * `mobile-runtime.browser.test.ts` covered.
 */
export async function executeMobileTerminalScrollbackScenario(
    environment: Environment,
    artifacts: string[],
    capture: (environment: Environment, label: string, artifacts: string[]) => Promise<void>,
    finish: (
        environment: Environment,
        artifacts: string[],
        receipt: Record<string, unknown>,
    ) => Promise<void>,
): Promise<void> {
    const { remoteVideoPath } = environment;
    if (!remoteVideoPath) throw new Error('Terminal recording path is unavailable');
    const fixture = await createMobileTerminalAcceptanceFixture(environment.serial);
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        const { surface } = await prepareMobileTerminalFixture(fixture, environment);
        await fixture.pair();
        await tapMobileCheck(environment.serial, `session-row-${fixture.sessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-detail'),
        );
        await tapMobileCheck(environment.serial, 'session-segment-terminal');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'terminal-live-webview'),
        );
        recording = await startMobileFramebufferRecording(environment.serial, remoteVideoPath);

        await pageRequest(fixture.running.page, 'terminal.input', {
            terminalId: fixture.terminalId,
            data: 's',
        });
        await waitForMobile(
            () => fixture.menuState(),
            ({ scrollback }) => scrollback?.printed === SCROLLBACK_LINE_COUNT,
        );
        const lastLabel = scrollbackLineLabel(SCROLLBACK_LINE_COUNT);
        await waitForMobile(
            () => surface.locator('.xterm-rows > div').allTextContents(),
            (lines) => lines.some((line) => line.trim() === lastLabel),
        );
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.every(({ checkId }) => checkId !== 'terminal-jump-latest'),
        );
        await capture(environment, 'scrollback-latest', artifacts);

        const webview = (await mobileSemantics(environment.serial)).find(
            ({ checkId }) => checkId === 'terminal-live-webview',
        );
        const bounds = webview && androidBounds(webview.bounds);
        if (!bounds) throw new Error('Terminal viewport bounds are unavailable');
        const x = Math.round((bounds.left + bounds.right) / 2);
        const height = bounds.bottom - bounds.top;
        /**
         * A finger drag downward moves content down, revealing the earlier output above it -- the same direction the
         * issue describes and the same gesture shape as the existing MOB-TERM-01/MOB-TERM-SCROLL-FEEL-01 swipes.
         */
        await adbShell(environment.serial, [
            'input',
            'swipe',
            String(x),
            String(Math.round(bounds.top + height * 0.3)),
            String(x),
            String(Math.round(bounds.top + height * 0.85)),
            '500',
        ]);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'terminal-jump-latest'),
        );
        const revealedAt = SCROLLBACK_LINE_COUNT - 5;
        const revealed = await waitForMobile(
            () => surface.locator('.xterm-rows > div').allTextContents(),
            (lines) => hasEarlierLine(lines, revealedAt),
        );
        expect(hasEarlierLine(revealed, revealedAt)).toBe(true);
        await capture(environment, 'scrollback-earlier-output-visible', artifacts);

        await tapMobileCheck(environment.serial, 'terminal-jump-latest');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.every(({ checkId }) => checkId !== 'terminal-jump-latest'),
        );
        await waitForMobile(
            () => surface.locator('.xterm-rows > div').allTextContents(),
            (lines) => lines.some((line) => line.trim() === lastLabel),
        );
        await capture(environment, 'scrollback-jump-latest-restored', artifacts);

        await finish(environment, artifacts, {
            lineCount: SCROLLBACK_LINE_COUNT,
            revealedEarlierOutput: true,
            status: 'passed',
        });
    } finally {
        try {
            await recording?.stop();
        } finally {
            await fixture.stop();
        }
    }
}
