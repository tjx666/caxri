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
import type { MobileTerminalAcceptanceFixture } from './mobile-terminal-acceptance-fixture';
import { createMobileTerminalAcceptanceFixture } from './mobile-terminal-acceptance-fixture';
import type { Environment } from './mobile-terminal-scenarios';
import { prepareMobileTerminalFixture } from './mobile-terminal-scenarios';

type MenuState = Awaited<ReturnType<MobileTerminalAcceptanceFixture['menuState']>>;
type DocumentInput = 'keys' | 'mouse';

interface Viewport {
    height: number;
    rows: number;
    top: number;
    x: number;
}

interface DragMeasurement {
    /**
     * Finger travel in device pixels.
     */
    dragPx: number;
    /**
     * Lines the finger travel spans at the displayed row height. The leased grid leaves less than one row of the
     * viewport unused, so the true row height lies between `viewport / (rows + 1)` and `viewport / rows`.
     */
    fingerLines: { max: number; min: number };
    /**
     * Lines the synthetic document actually moved; negative reveals earlier lines.
     */
    documentLines: number;
    /**
     * Scroll steps the application received: SGR wheel reports or cursor keys, by direction.
     */
    stepsDown: number;
    stepsUp: number;
}

const stepsOf = (state: MenuState, input: DocumentInput) =>
    input === 'mouse'
        ? { down: state.wheelDown, up: state.wheelUp }
        : { down: state.keyDown, up: state.keyUp };

/**
 * Waits until the fake Agent stops receiving scroll steps, so a measurement includes every coalesced and gliding frame.
 */
async function settledState(fixture: MobileTerminalAcceptanceFixture): Promise<MenuState> {
    const total = (state: MenuState) =>
        state.wheelUp + state.wheelDown + state.keyUp + state.keyDown;
    let previous = await fixture.menuState();
    let stableSamples = 0;
    const deadline = Date.now() + 20_000;
    while (stableSamples < 4) {
        if (Date.now() > deadline) throw new Error('Terminal scroll input did not settle');
        // eslint-disable-next-line no-await-in-loop -- each sample is spaced to observe a quiet period.
        await new Promise((resolve) => setTimeout(resolve, 250));
        // eslint-disable-next-line no-await-in-loop -- the next sample compares against this one.
        const next = await fixture.menuState();
        stableSamples = total(next) === total(previous) ? stableSamples + 1 : 0;
        previous = next;
    }
    return previous;
}

const round = (value: number) => Math.round(value * 10) / 10;

function measure(
    input: DocumentInput,
    before: MenuState,
    after: MenuState,
    dragPx: number,
    viewport: Viewport,
): DragMeasurement {
    if (after.document?.input !== input || before.document?.input !== input)
        throw new Error('Synthetic document is unavailable');
    /**
     * A clamped document would hide steps that arrived at its edge.
     */
    if (after.document.top <= 0 || after.document.top >= after.document.lines - viewport.rows)
        throw new Error('Synthetic document reached its edge during a measurement');
    const beforeSteps = stepsOf(before, input);
    const afterSteps = stepsOf(after, input);
    return {
        documentLines: after.document.top - before.document.top,
        dragPx,
        fingerLines: {
            max: round((dragPx * (viewport.rows + 1)) / viewport.height),
            min: round((dragPx * viewport.rows) / viewport.height),
        },
        stepsDown: afterSteps.down - beforeSteps.down,
        stepsUp: afterSteps.up - beforeSteps.up,
    };
}

/**
 * Drags one finger in small steps and rests on the device before lifting it, the way a reader moves content
 * deliberately. The rest is far longer than the 80 ms momentum window, so every scroll step comes from finger travel.
 */
async function slowDrag(serial: string, x: number, from: number, to: number): Promise<void> {
    const steps = 24;
    const moves = Array.from(
        { length: steps },
        (_, index) =>
            `input motionevent MOVE ${x} ${Math.round(from + ((to - from) * (index + 1)) / steps)}`,
    );
    await adbShell(serial, [
        [
            `input motionevent DOWN ${x} ${from}`,
            ...moves,
            'sleep 0.5',
            `input motionevent UP ${x} ${to}`,
        ].join('; '),
    ]);
}

/**
 * A quick flick lifts the finger while it still moves, so the document keeps gliding after release.
 */
async function fling(serial: string, x: number, from: number, to: number): Promise<void> {
    await adbShell(serial, [
        'input',
        'swipe',
        String(x),
        String(from),
        String(x),
        String(to),
        '120',
    ]);
}

/**
 * Pointer location draws the finger trail and its travel in the recording, so a reader can compare it with how far the
 * synthetic document moved. The previous value is restored afterwards.
 */
async function showPointerLocation(serial: string): Promise<() => Promise<void>> {
    const previous = (await adbShell(serial, ['settings', 'get', 'system', 'pointer_location']))
        .trim()
        .replace(/^null$/u, '0');
    if (!/^[01]$/u.test(previous)) throw new Error('Pointer location setting is unreadable');
    await adbShell(serial, ['settings', 'put', 'system', 'pointer_location', '1']);
    return async () => {
        await adbShell(serial, ['settings', 'put', 'system', 'pointer_location', previous]);
    };
}

async function openDocument(
    fixture: MobileTerminalAcceptanceFixture,
    input: DocumentInput,
): Promise<void> {
    await pageRequest(fixture.running.page, 'terminal.input', {
        terminalId: fixture.terminalId,
        data: input === 'mouse' ? 'd' : 'k',
    });
    await waitForMobile(
        () => fixture.menuState(),
        ({ document, rows }) =>
            document?.input === input && rows !== null && document.top === document.lines - rows,
    );
}

async function closeDocument(fixture: MobileTerminalAcceptanceFixture): Promise<void> {
    const { document } = await fixture.menuState();
    await pageRequest(fixture.running.page, 'terminal.input', {
        terminalId: fixture.terminalId,
        data: document?.input === 'keys' ? 'k' : 'd',
    });
    await waitForMobile(
        () => fixture.menuState(),
        ({ fullscreen }) => !fullscreen,
    );
}

/**
 * Drags the document down slowly, back up slowly, then flicks it three times. Each slow drag must produce one scroll
 * step per displayed row of finger travel, and the document must move exactly one line per step.
 */
async function measureDocument(
    environment: Environment,
    artifacts: string[],
    capture: (environment: Environment, label: string, artifacts: string[]) => Promise<void>,
    fixture: MobileTerminalAcceptanceFixture,
    input: DocumentInput,
    viewport: Viewport,
) {
    const { serial } = environment;
    const at = (fraction: number) => Math.round(viewport.top + viewport.height * fraction);
    await capture(environment, `${input}-document-end`, artifacts);

    const start = await settledState(fixture);
    await slowDrag(serial, viewport.x, at(0.2), at(0.7));
    const afterDown = await settledState(fixture);
    const slowDown = measure(input, start, afterDown, at(0.7) - at(0.2), viewport);
    await capture(environment, `${input}-slow-drag-down`, artifacts);

    await slowDrag(serial, viewport.x, at(0.7), at(0.45));
    const afterUp = await settledState(fixture);
    const slowUp = measure(input, afterDown, afterUp, at(0.7) - at(0.45), viewport);
    await capture(environment, `${input}-slow-drag-up`, artifacts);

    for (const [measurement, direction] of [
        [slowDown, 'stepsUp'],
        [slowUp, 'stepsDown'],
    ] as const) {
        const steps = measurement[direction];
        /**
         * The sub-row remainder of a drag is dropped, so a drag may fall one step short of its span.
         */
        expect(steps).toBeGreaterThanOrEqual(Math.floor(measurement.fingerLines.min) - 1);
        expect(steps).toBeLessThanOrEqual(Math.ceil(measurement.fingerLines.max));
        expect(Math.abs(measurement.documentLines)).toBe(steps);
    }
    expect(slowDown.stepsDown).toBe(0);
    expect(slowUp.stepsUp).toBe(0);

    const flings: DragMeasurement[] = [];
    let previous = afterUp;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- each flick starts from the previous settled document.
        await fling(serial, viewport.x, at(0.3), at(0.6));
        // eslint-disable-next-line no-await-in-loop -- the glide must end before the next flick.
        const next = await settledState(fixture);
        const measurement = measure(input, previous, next, at(0.6) - at(0.3), viewport);
        expect(measurement.stepsDown).toBe(0);
        expect(Math.abs(measurement.documentLines)).toBe(measurement.stepsUp);
        /**
         * Released while moving, the document glides past the finger's own span.
         */
        expect(measurement.stepsUp).toBeGreaterThan(measurement.fingerLines.max);
        flings.push(measurement);
        previous = next;
    }
    await capture(environment, `${input}-fling-settled`, artifacts);
    return { flings, slowDragDown: slowDown, slowDragUp: slowUp };
}

/**
 * Measures how far a synthetic full-screen application scrolls for a phone drag (MOB-TERM-SCROLL-FEEL-01, #1287). The
 * fake Agent moves its document one line per scroll step, the way pagers and most full-screen TUIs respond, through
 * both encodings the Host uses: SGR wheel reports while it tracks the mouse, and cursor keys on a plain alternate
 * screen. The receipt compares finger travel in displayed rows with the steps the application received.
 */
export async function executeMobileTerminalScrollFeelScenario(
    environment: Environment,
    artifacts: string[],
    capture: (environment: Environment, label: string, artifacts: string[]) => Promise<void>,
    finish: (
        environment: Environment,
        artifacts: string[],
        receipt: Record<string, unknown>,
    ) => Promise<void>,
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath) throw new Error('Terminal recording path is unavailable');
    if (!/^emulator-\d+$/u.test(serial))
        throw new Error('Scroll feel measurement requires an explicit disposable emulator serial');
    const fixture = await createMobileTerminalAcceptanceFixture(serial);
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    let restorePointerLocation: (() => Promise<void>) | undefined;
    try {
        const { desktopSize } = await prepareMobileTerminalFixture(fixture, environment);
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.sessionId}`);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-detail'),
        );
        await tapMobileCheck(serial, 'session-segment-terminal');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === 'terminal-live-webview') &&
                nodes.some(({ checkId, enabled }) => checkId === 'terminal-take-over' && enabled),
        );

        /**
         * Holding the lease gives the phone its own grid, so the whole document fits the viewport and a vertical drag
         * reaches the application instead of first panning a Desktop-sized grid.
         */
        await tapMobileCheck(serial, 'terminal-take-over');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'terminal-release'),
        );
        let leased = await waitForMobile(
            () => fixture.menuState(),
            ({ cols, rows }) =>
                cols !== null && (cols !== desktopSize.cols || rows !== desktopSize.rows),
        );
        for (let attempt = 0; attempt < 10; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- each sample waits past the lease debounce.
            await new Promise((resolve) => setTimeout(resolve, 1000));
            // eslint-disable-next-line no-await-in-loop -- the next sample depends on this one.
            const next = await fixture.menuState();
            if (next.cols === leased.cols && next.rows === leased.rows) break;
            leased = next;
        }
        if (leased.rows === null) throw new Error('Leased synthetic grid is unavailable');
        const webview = (await mobileSemantics(serial)).find(
            ({ checkId }) => checkId === 'terminal-live-webview',
        );
        const bounds = webview && androidBounds(webview.bounds);
        if (!bounds) throw new Error('Terminal viewport bounds are unavailable');
        const viewport: Viewport = {
            height: bounds.bottom - bounds.top,
            rows: leased.rows,
            top: bounds.top,
            x: Math.round((bounds.left + bounds.right) / 2),
        };

        restorePointerLocation = await showPointerLocation(serial);
        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await openDocument(fixture, 'mouse');
        const mouse = await measureDocument(
            environment,
            artifacts,
            capture,
            fixture,
            'mouse',
            viewport,
        );
        await closeDocument(fixture);
        await openDocument(fixture, 'keys');
        const keys = await measureDocument(
            environment,
            artifacts,
            capture,
            fixture,
            'keys',
            viewport,
        );
        await closeDocument(fixture);
        await recording.stop();
        recording = undefined;

        await finish(environment, artifacts, {
            cursorKeyPath: keys,
            leasedGrid: { cols: leased.cols, rows: leased.rows },
            linesPerScrollStep: 1,
            status: 'passed',
            viewportHeightPx: viewport.height,
            wheelReportPath: mouse,
        });
    } finally {
        try {
            await recording?.stop();
        } finally {
            try {
                await restorePointerLocation?.();
            } finally {
                await fixture.stop();
            }
        }
    }
}
