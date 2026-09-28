import { expect } from '@playwright/test';

import type { E2EApp } from './electron-app.ts';

/**
 * One entry of the native context menu Main parked for the test, as the Renderer sent it. Mirrors `ContextMenuItemSpec`
 * from `@caxri/protocol`; labels carry no shortcut suffix because Main appends chord hints only to a real popup.
 */
export interface NativeContextMenuItem {
    type: 'item' | 'separator' | 'submenu';
    id?: number;
    label?: string;
    enabled?: boolean;
    /**
     * Why a disabled entry is unavailable; Main shows it with the entry because a native menu has no tooltip.
     */
    disabledReason?: string;
    shortcut?: string;
    submenu?: NativeContextMenuItem[];
}

interface ChooseContextMenuItemOptions {
    /**
     * Replays how a real menu hands keyboard focus back as it closes, after the click and before the choice is
     * delivered (see `E2EContextMenuChooseOptions` in `apps/desktop/src/main/context-menu.ts`). Pass it when the chosen
     * action moves focus, such as Rename or New File, so the spec proves the focus survives the close.
     */
    refocusOnClose?: boolean;
}

/**
 * E2E launches never pop a real native menu (see `apps/desktop/src/main/context-menu.ts`): Main parks the request on
 * `globalThis.caxriE2EContextMenu` and waits for the test to answer through `app.evaluate`. These helpers read and
 * answer that probe, so the Renderer → Main → Renderer round trip a real click performs is still exercised.
 */
async function readPendingMenu(app: E2EApp): Promise<NativeContextMenuItem[] | null> {
    return app.evaluate(() => {
        const probe = (
            globalThis as typeof globalThis & {
                caxriE2EContextMenu?: { items: unknown[] };
            }
        ).caxriE2EContextMenu;
        return probe ? (probe.items as never) : null;
    });
}

/**
 * Waits until a context menu is open and returns its top-level entries.
 */
export async function waitForContextMenu(app: E2EApp): Promise<NativeContextMenuItem[]> {
    let items: NativeContextMenuItem[] | null = null;
    await expect
        .poll(
            async () => {
                items = await readPendingMenu(app);
                return items !== null;
            },
            { message: 'a native context menu opens' },
        )
        .toBe(true);
    return items!;
}

/**
 * Labels of the selectable top-level entries, in order, for `toEqual`/`toContain` assertions.
 */
export async function contextMenuLabels(app: E2EApp): Promise<string[]> {
    return (await waitForContextMenu(app))
        .filter((item) => item.type !== 'separator')
        .map((item) => item.label ?? '');
}

/**
 * Finds one entry by label, descending through submenu labels when given a path.
 */
async function findContextMenuItem(
    app: E2EApp,
    label: string | readonly string[],
): Promise<NativeContextMenuItem> {
    const path = typeof label === 'string' ? [label] : label;
    let level = await waitForContextMenu(app);
    let found: NativeContextMenuItem | undefined;
    for (const [index, segment] of path.entries()) {
        found = level.find((item) => item.type !== 'separator' && item.label === segment);
        if (!found) {
            const available = level.filter((item) => item.label).map((item) => item.label);
            throw new Error(
                `Context menu has no "${segment}"; available: ${JSON.stringify(available)}`,
            );
        }
        if (index < path.length - 1) level = found.submenu ?? [];
    }
    return found!;
}

export async function isContextMenuItemEnabled(
    app: E2EApp,
    label: string | readonly string[],
): Promise<boolean> {
    return (await findContextMenuItem(app, label)).enabled !== false;
}

/**
 * The reason a disabled entry shows beside its label, or `undefined` when it carries none.
 */
export async function contextMenuItemDisabledReason(
    app: E2EApp,
    label: string | readonly string[],
): Promise<string | undefined> {
    return (await findContextMenuItem(app, label)).disabledReason;
}

/**
 * Chooses an enabled entry, exactly as clicking it in the native menu would, and returns once the menu has closed.
 */
export async function chooseContextMenuItem(
    app: E2EApp,
    label: string | readonly string[],
    options: ChooseContextMenuItemOptions = {},
): Promise<void> {
    const item = await findContextMenuItem(app, label);
    if (item.type !== 'item' || item.id === undefined)
        throw new Error(`Context menu entry "${String(label)}" is not selectable`);
    if (item.enabled === false)
        throw new Error(`Context menu entry "${String(label)}" is disabled`);
    await answerPendingMenu(app, item.id, options);
}

/**
 * Closes the open menu without a choice, as Escape or an outside click does.
 */
export async function dismissContextMenu(app: E2EApp): Promise<void> {
    await waitForContextMenu(app);
    await answerPendingMenu(app, undefined);
}

export async function expectNoContextMenu(app: E2EApp): Promise<void> {
    await expect.poll(() => readPendingMenu(app)).toBeNull();
}

async function answerPendingMenu(
    app: E2EApp,
    id: number | undefined,
    options: ChooseContextMenuItemOptions = {},
): Promise<void> {
    await app.evaluate(
        async (_electron, { selectedId, chooseOptions }) => {
            const probe = (
                globalThis as typeof globalThis & {
                    caxriE2EContextMenu?: {
                        choose(id?: number, options?: ChooseContextMenuItemOptions): Promise<void>;
                    };
                }
            ).caxriE2EContextMenu;
            if (!probe) throw new Error('No native context menu is open');
            await probe.choose(selectedId ?? undefined, chooseOptions);
        },
        { selectedId: id ?? null, chooseOptions: options },
    );
}
