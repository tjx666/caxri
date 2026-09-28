import { join } from 'node:path';

import { createTerminalFixturePreflightReceipt } from '../../.agents/skills/acceptance/scripts/fixture-preflight';
import { writeJsonAtomic } from '../../scripts/atomic-json';
import { expect } from './fixtures';
import { pageRequest } from './helpers';
import {
    adbShell,
    androidBounds,
    mobileSemantics,
    setMobileNetworkAvailable,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import { pinchTerminal } from './mobile-native-pinch';
import type { MobileTerminalAcceptanceFixture } from './mobile-terminal-acceptance-fixture';
import { createMobileTerminalAcceptanceFixture } from './mobile-terminal-acceptance-fixture';
import { tapTerminalKey } from './mobile-terminal-key';

export interface Environment {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    scenarioReceiptPath: string;
    serial: string;
    sourceCommit?: string;
    launchId?: string;
    remoteVideoPath?: string;
}

/**
 * Sizes Desktop's window for a tall synthetic grid, waits until Desktop renders exactly the fake Agent's grid, and
 * writes the formal fixture preflight receipt that every captured Terminal frame depends on.
 */
export async function prepareMobileTerminalFixture(
    fixture: MobileTerminalAcceptanceFixture,
    environment: Environment,
) {
    const { launchId, sourceCommit } = environment;
    const surface = fixture.running.page.locator(
        `.terminal-pane[data-terminal-id="${fixture.terminalId}"] .terminal-surface`,
    );
    await fixture.running.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 1500 });
    });
    await waitForMobile(
        () => fixture.menuState(),
        ({ rows }) => rows !== null && rows >= 50,
    );
    await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
    await expect(surface).toHaveAttribute('data-terminal-grid', /^\d+x\d+$/u);
    const desktopGrid = await surface.getAttribute('data-terminal-grid');
    const grid = /^(\d+)x(\d+)$/u.exec(desktopGrid ?? '');
    if (!grid) throw new Error('Desktop Terminal grid is unavailable');
    const desktopSize = { cols: Number(grid[1]), rows: Number(grid[2]) };
    await waitForMobile(
        () => fixture.menuState(),
        ({ cols, rows }) => cols === desktopSize.cols && rows === desktopSize.rows,
    );

    if (!sourceCommit || !launchId)
        throw new Error('Terminal fixture Acceptance identity is incomplete');
    const observedGrid = await waitForMobile(
        async () => {
            const state = await fixture.menuState();
            const renderedRows = await surface.locator('.xterm-rows > div').allTextContents();
            const grid = await surface.getAttribute('data-terminal-grid');
            return { grid, renderedRows, state };
        },
        ({ grid, renderedRows, state }) =>
            state.cols !== null &&
            state.rows !== null &&
            grid === `${state.cols}x${state.rows}` &&
            renderedRows.length === state.rows &&
            renderedRows[0]?.startsWith(`│${state.generation} `) &&
            renderedRows.every((line, index) => line === state.lines[index]),
    );
    if (observedGrid.state.cols === null || observedGrid.state.rows === null)
        throw new Error('Synthetic Terminal grid is unavailable');
    const preflight = createTerminalFixturePreflightReceipt(
        {
            columns: observedGrid.state.cols,
            domRowCount: observedGrid.renderedRows.length,
            firstGridMarker: observedGrid.state.firstGridMarker,
            generation: observedGrid.state.generation,
            lines: observedGrid.renderedRows,
            rows: observedGrid.state.rows,
        },
        environment.caseId,
        { launchId, sourceCommit },
    );
    if (preflight.result.status !== 'ready')
        throw new Error('Synthetic Terminal formal fixture preflight was blocked');
    const preflightName = `${environment.caseId}-fixture-preflight.json`;
    await writeJsonAtomic(join(environment.assetsDirectory, preflightName), preflight);
    return { desktopSize, surface };
}

export async function executeMobileTerminalScenario(
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
        const { desktopSize, surface } = await prepareMobileTerminalFixture(fixture, environment);

        await fixture.pair();
        await tapMobileCheck(environment.serial, `session-row-${fixture.sessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-detail'),
        );
        await tapMobileCheck(environment.serial, 'session-segment-terminal');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === 'terminal-live-webview') &&
                nodes.some(({ checkId, enabled }) => checkId === 'terminal-take-over' && enabled),
        );
        await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
        recording = await startMobileFramebufferRecording(environment.serial, remoteVideoPath);
        const observingSize = await fixture.menuState();
        expect({ cols: observingSize.cols, rows: observingSize.rows }).toEqual(desktopSize);
        await capture(environment, 'observing', artifacts);
        await pinchTerminal(environment.serial, 'pinch-in');
        await capture(environment, 'fit-to-screen', artifacts);
        await pinchTerminal(environment.serial, 'pinch-out');
        await capture(environment, 'readable-default-restored', artifacts);
        const afterPinch = await fixture.menuState();
        expect({ cols: afterPinch.cols, rows: afterPinch.rows }).toEqual(desktopSize);
        const windowBounds = await fixture.running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].getBounds(),
        );
        await fixture.running.app.evaluate(
            ({ BrowserWindow }, bounds) =>
                BrowserWindow.getAllWindows()[0].setBounds({
                    ...bounds,
                    width: bounds.width - 150,
                }),
            windowBounds,
        );
        await waitForMobile(
            () => fixture.menuState(),
            ({ cols }) => cols !== desktopSize.cols,
        );
        for (let sample = 0; sample < 3; sample += 1) {
            // eslint-disable-next-line no-await-in-loop -- Each native observation samples the resized stream.
            const nodes = await mobileSemantics(environment.serial);
            expect(nodes.some(({ checkId }) => checkId === 'terminal-stale')).toBe(false);
            expect(nodes.some(({ checkId }) => checkId === 'connection-stale-banner')).toBe(false);
        }
        await capture(environment, 'observing-resized', artifacts);
        await fixture.running.app.evaluate(
            ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds),
            windowBounds,
        );
        await waitForMobile(
            () => fixture.menuState(),
            ({ cols }) => cols === desktopSize.cols,
        );
        const webview = (await mobileSemantics(environment.serial)).find(
            ({ checkId }) => checkId === 'terminal-live-webview',
        );
        const bounds = webview && androidBounds(webview.bounds);
        if (!bounds) throw new Error('Terminal viewport bounds are unavailable');
        const x = Math.round((bounds.left + bounds.right) / 2);
        const height = bounds.bottom - bounds.top;
        await adbShell(environment.serial, [
            'input',
            'swipe',
            String(x),
            String(Math.round(bounds.top + height * 0.35)),
            String(x),
            String(Math.round(bounds.top + height * 0.8)),
            '500',
        ]);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'terminal-jump-latest'),
        );
        await pageRequest(fixture.running.page, 'terminal.input', {
            terminalId: fixture.terminalId,
            data: '\u{1B}[B',
        });
        await waitForMobile(
            () => fixture.menuState(),
            ({ selected }) => selected === 2,
        );
        expect(
            (await mobileSemantics(environment.serial)).some(
                ({ checkId }) => checkId === 'terminal-jump-latest',
            ),
        ).toBe(true);
        await capture(environment, 'reading-position-retained', artifacts);
        await tapMobileCheck(environment.serial, 'terminal-jump-latest');
        await pageRequest(fixture.running.page, 'terminal.input', {
            terminalId: fixture.terminalId,
            data: '\u{1B}[A',
        });
        await waitForMobile(
            () => fixture.menuState(),
            ({ selected }) => selected === 1,
        );
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.every(({ checkId }) => checkId !== 'terminal-jump-latest'),
        );
        await capture(environment, 'tall-grid-latest', artifacts);

        /**
         * A full-screen Agent keeps no xterm scrollback; the phone's drag must reach it as wheel input without a lease.
         */
        await pageRequest(fixture.running.page, 'terminal.input', {
            terminalId: fixture.terminalId,
            data: 'f',
        });
        await waitForMobile(
            () => fixture.menuState(),
            ({ fullscreen }) => fullscreen,
        );
        await adbShell(environment.serial, [
            'input',
            'swipe',
            String(x),
            String(Math.round(bounds.top + height * 0.35)),
            String(x),
            String(Math.round(bounds.top + height * 0.8)),
            '500',
        ]);
        const scrolled = await waitForMobile(
            () => fixture.menuState(),
            ({ wheelUp }) => wheelUp > 0,
        );
        expect(scrolled.wheelDown).toBe(0);
        expect({ cols: scrolled.cols, rows: scrolled.rows }).toEqual(desktopSize);
        await capture(environment, 'fullscreen-scrolled-without-lease', artifacts);
        await pageRequest(fixture.running.page, 'terminal.input', {
            terminalId: fixture.terminalId,
            data: 'f',
        });
        await waitForMobile(
            () => fixture.menuState(),
            ({ fullscreen }) => !fullscreen,
        );

        await tapMobileCheck(environment.serial, 'terminal-take-over');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'terminal-release'),
        );
        /**
         * The leased grid can be wider than Desktop's tall fixture grid, and it shrinks once more when the key row
         * appears, so wait for a changed size that holds across a full lease debounce.
         */
        let takenOver = await waitForMobile(
            () => fixture.menuState(),
            ({ cols, rows }) =>
                cols !== null && (cols !== desktopSize.cols || rows !== desktopSize.rows),
        );
        for (let attempt = 0; attempt < 10; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- each sample waits past the lease debounce.
            await new Promise((resolve) => setTimeout(resolve, 1000));
            // eslint-disable-next-line no-await-in-loop -- the next sample depends on this one.
            const next = await fixture.menuState();
            if (next.cols === takenOver.cols && next.rows === takenOver.rows) break;
            takenOver = next;
        }
        /**
         * The leased grid keeps the observing text size; a full-size font gave a phone only about 49 columns.
         */
        expect(takenOver.cols).toBeGreaterThan(60);
        /**
         * Taking over jumps to the latest output, so the blinking cursor is on screen for the recording.
         */
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.every(({ checkId }) => checkId !== 'terminal-jump-latest'),
        );
        await capture(environment, 'taken-over', artifacts);

        try {
            await fixture.running.app.evaluate(
                ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds),
                {
                    ...windowBounds,
                    width:
                        windowBounds.width > 800
                            ? windowBounds.width - 180
                            : windowBounds.width + 180,
                },
            );
            await waitForMobile(
                () =>
                    fixture.running.app.evaluate(({ BrowserWindow }) =>
                        BrowserWindow.getAllWindows()[0].getBounds(),
                    ),
                ({ width }) => width !== windowBounds.width,
            );
            for (let sample = 0; sample < 5; sample += 1) {
                // eslint-disable-next-line no-await-in-loop -- each sample watches the held mobile lease after Desktop resize.
                const nodes = await mobileSemantics(environment.serial);
                expect(nodes.some(({ checkId }) => checkId === 'terminal-release')).toBe(true);
                expect(nodes.some(({ checkId }) => checkId === 'terminal-stale')).toBe(false);
                // eslint-disable-next-line no-await-in-loop -- a brief interval catches a delayed stale chip.
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
            const heldSize = await fixture.menuState();
            expect({ cols: heldSize.cols, rows: heldSize.rows }).toEqual({
                cols: takenOver.cols,
                rows: takenOver.rows,
            });
            await capture(environment, 'desktop-resized-under-lease', artifacts);
        } finally {
            await fixture.running.app.evaluate(
                ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds),
                windowBounds,
            );
            await waitForMobile(
                () =>
                    fixture.running.app.evaluate(({ BrowserWindow }) =>
                        BrowserWindow.getAllWindows()[0].getBounds(),
                    ),
                ({ width, height }) =>
                    width === windowBounds.width && height === windowBounds.height,
            );
            /**
             * Desktop keeps the mobile-owned grid until release, even after its window is restored.
             */
            await expect(surface).toHaveAttribute(
                'data-terminal-grid',
                `${takenOver.cols}x${takenOver.rows}`,
            );
        }

        await pinchTerminal(environment.serial, 'pinch-out', 'leased');
        const zoomed = await waitForMobile(
            () => fixture.menuState(),
            ({ cols }) => cols !== null && takenOver.cols !== null && cols < takenOver.cols,
        );
        await capture(environment, 'taken-over-zoomed-reflowed', artifacts);

        await tapTerminalKey(environment.serial, 'down');
        await waitForMobile(
            () => fixture.menuState(),
            ({ selected }) => selected === 2,
        );
        await tapTerminalKey(environment.serial, 'enter');
        await waitForMobile(
            () => fixture.menuState(),
            ({ submissions }) => submissions === 1,
        );
        await waitForMobile(
            () =>
                surface
                    .locator('.xterm-rows')
                    .evaluate((rows) => rows.textContent.includes('Selection submitted')),
            Boolean,
        );
        await capture(environment, 'menu-submitted', artifacts);

        await tapMobileCheck(environment.serial, 'terminal-release');
        const released = await waitForMobile(
            () => fixture.menuState(),
            ({ cols, rows }) => cols === desktopSize.cols && rows === desktopSize.rows,
        );
        /**
         * Restoring the PTY size can invalidate the mobile stream generation. The desktop grid alone does not prove
         * that the phone has acquired its replacement snapshot and can observe/control again.
         */
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.some(({ checkId, enabled }) => checkId === 'terminal-take-over' && enabled) &&
                nodes.every(
                    ({ checkId }) =>
                        !(checkId === 'terminal-stale' || checkId === 'terminal-error'),
                ),
        );
        await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
        await capture(environment, 'released', artifacts);
        try {
            await setMobileNetworkAvailable(environment.serial, false);
            await waitForMobile(
                () => mobileSemantics(environment.serial),
                (nodes) => nodes.some(({ checkId }) => checkId === 'connection-stale-banner'),
            );
            await capture(environment, 'network-disconnected', artifacts);
        } finally {
            await setMobileNetworkAvailable(environment.serial, true);
        }
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.every(({ checkId }) => checkId !== 'connection-stale-banner') &&
                nodes.some(({ checkId, enabled }) => checkId === 'terminal-take-over' && enabled),
        );

        await finish(environment, artifacts, {
            desktopAttachment: 'preserved',
            observingResize: 'no-stale-banner',
            tallGrid: {
                rows: desktopSize.rows,
                fitToScreen: 'native-pinch-in-and-out-captured',
                scrollPosition: 'retained-until-latest',
                output: 'follows-bottom',
            },
            networkDisconnect: 'stale-banner-visible-and-recovered',
            desktopResizeUnderLease: 'mobile-control-retained-without-stale-chip',
            desktopSize,
            menuSelection: 'second-option-submitted-once',
            observingSize: { cols: observingSize.cols, rows: observingSize.rows },
            releasedSize: { cols: released.cols, rows: released.rows },
            status: 'passed',
            takenOverSize: { cols: takenOver.cols, rows: takenOver.rows },
            takenOverZoomedSize: { cols: zoomed.cols, rows: zoomed.rows },
            fullscreenScroll: { wheelDown: scrolled.wheelDown, wheelUp: scrolled.wheelUp },
        });
    } finally {
        try {
            await recording?.stop();
        } finally {
            await fixture.stop();
        }
    }
}
