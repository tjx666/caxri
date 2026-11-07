import { join } from 'node:path';

import { createTerminalFixturePreflightReceipt } from '../../.agents/skills/acceptance/scripts/fixture-preflight';
import { writeJsonAtomic } from '../../scripts/atomic-json';
import { expect } from './fixtures';
import type { MobileAcceptanceFixture } from './mobile-acceptance-fixture';
import { waitForMobile } from './mobile-android';

/**
 * The integrated journey fixture parts the Desktop Terminal grid reads need.
 */
type GridFixture = Pick<MobileAcceptanceFixture, 'running'> & {
    journey: NonNullable<MobileAcceptanceFixture['journey']>;
};

/**
 * Where a journey case writes its Terminal fixture preflight receipt, and the identities it binds.
 */
interface GridEnvironment {
    assetsDirectory: string;
    caseId: string;
    launchId: string;
    sourceCommit: string;
}

/**
 * Waits until the Desktop renders the synthetic Conversation Terminal in `phase` exactly as the fixture last drew it:
 * the attached surface's grid matches the PTY size and every rendered row matches the fixture's frame.
 */
export async function waitForDesktopConversationGrid(
    fixture: GridFixture,
    phase: 'busy' | 'menu',
    selected?: number,
) {
    const surface = fixture.running.page.locator(
        `.terminal-pane[data-terminal-id="${fixture.journey.conversationTerminalId}"] .terminal-surface`,
    );
    await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
    return waitForMobile(
        async () => ({
            grid: await surface.getAttribute('data-terminal-grid'),
            renderedRows: await surface.locator('.xterm-rows > div').allTextContents(),
            state: await fixture.journey.conversationMenuState(),
        }),
        ({ grid, renderedRows, state }) =>
            state?.phase === phase &&
            (selected === undefined || state.selected === selected) &&
            grid === `${state.cols}x${state.rows}` &&
            renderedRows.length === state.rows &&
            renderedRows[0]?.startsWith(`│${state.generation} `) &&
            renderedRows.every((line, index) => line === state.lines[index]),
    );
}

/**
 * Waits until the Desktop renders the menu at the given grid size. A Terminal lease change resizes the PTY
 * asynchronously, and the previous size still reads as a settled frame for a moment after the tap.
 */
export const waitForDesktopMenuGrid = (
    fixture: GridFixture,
    selected: number,
    size: { cols: number | null; rows: number | null },
) =>
    waitForMobile(
        () => waitForDesktopConversationGrid(fixture, 'menu', selected),
        ({ state }) => state?.cols === size.cols && state.rows === size.rows,
    );

/**
 * Writes the case's ready Terminal fixture preflight receipt from an observed Desktop grid.
 */
export async function writeReadyTerminalPreflight(
    environment: GridEnvironment,
    observed: Awaited<ReturnType<typeof waitForDesktopConversationGrid>>,
): Promise<void> {
    const state = observed.state;
    if (!state || state.cols === null || state.rows === null)
        throw new Error('Synthetic journey Terminal grid is unavailable');
    const receipt = createTerminalFixturePreflightReceipt(
        {
            columns: state.cols,
            domRowCount: observed.renderedRows.length,
            firstGridMarker: state.firstGridMarker,
            generation: state.generation,
            lines: observed.renderedRows,
            rows: state.rows,
        },
        environment.caseId,
        { launchId: environment.launchId, sourceCommit: environment.sourceCommit },
    );
    if (receipt.result.status !== 'ready')
        throw new Error('Integrated journey Terminal fixture preflight was blocked');
    await writeJsonAtomic(
        join(environment.assetsDirectory, `${environment.caseId}-fixture-preflight.json`),
        receipt,
    );
}

/**
 * Rechecks the exact Desktop grid after pairing so the receipt describes the frame before media.
 */
export async function preflightConversationTerminal(
    environment: GridEnvironment,
    fixture: GridFixture,
    expectedGeneration?: string,
): Promise<string> {
    const observed = await waitForDesktopConversationGrid(fixture, 'busy');
    const state = observed.state;
    if (!state) throw new Error('Synthetic journey Terminal grid is unavailable');
    if (expectedGeneration && state.generation !== expectedGeneration)
        throw new Error('Synthetic journey Terminal grid changed during mobile pairing');
    await writeReadyTerminalPreflight(environment, observed);
    return state.generation;
}
