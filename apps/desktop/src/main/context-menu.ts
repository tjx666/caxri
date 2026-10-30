import process from 'node:process';

import type { ContextMenuItemSpec, MainRequest, MethodResult } from '@caxri/protocol';
import { formatShortcut, shortcutLeadingChord } from '@caxri/protocol';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { Menu } from 'electron';

import { electronAccelerator } from './menu/accelerator';

type ContextMenuParameters = Extract<MainRequest, { method: 'contextMenu.show' }>['params'];
type ContextMenuResult = MethodResult<'contextMenu.show'>;

/**
 * E2E launches never pop a real menu: a native menu runs its own modal event loop, steals the developer's keyboard
 * focus, and cannot be driven by Playwright. Main parks the request here instead and
 * `e2e/support/native-context-menu.ts` reads the items and answers with an id through `app.evaluate`, which exercises
 * the same Renderer → Main → Renderer round trip a real click does.
 */
interface E2EContextMenuProbe {
    items: ContextMenuItemSpec[];
    /**
     * Answers the menu as a click on entry `id`, or as a dismissal without one, and settles once the menu has closed.
     */
    choose(id?: number, options?: E2EContextMenuChooseOptions): Promise<void>;
}

interface E2EContextMenuChooseOptions {
    /**
     * Replays, between the click and the close, what a real menu does to keyboard focus as it closes: after long enough
     * for a choice delivered too early to have focused its input, focus goes back to where it was when the menu took
     * over. A spec opts in where the chosen action moves focus, so delivering the choice before the close fails it.
     */
    refocusOnClose?: boolean;
}

declare global {
    // eslint-disable-next-line vars-on-top -- `declare global { var … }` is the required ambient form
    var caxriE2EContextMenu: E2EContextMenuProbe | undefined;
}

/**
 * Aliased so the probe writes read as plain property writes rather than the `globalThis.X = …` pattern
 * unicorn/no-global-object-property-assignment disallows; `app.evaluate` can only reach Main state through the global.
 */
const e2eScope: typeof globalThis = globalThis;

/**
 * The page half of `refocusOnClose`. Runs in the Renderer's main world through `executeJavaScript`, which is sent
 * before the choice is recorded, so it captures the focus the menu opened over even when a regression delivers the
 * choice at click time.
 */
const REFOCUS_ON_CLOSE_SCRIPT = `(async () => {
    const origin = document.activeElement;
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (origin instanceof HTMLElement && origin.isConnected) origin.focus({ preventScroll: true });
})()`;

/**
 * One open menu's answer, shared by the native popup and the E2E probe so both deliver the choice at the same moment:
 * `select` only records it, and `close` delivers it one macrotask after the menu has closed; see `showContextMenu`.
 */
function menuOutcome(resolve: (result: ContextMenuResult) => void): {
    close: () => void;
    select: (id: number) => void;
} {
    let selectedId: number | undefined;
    return {
        select: (id) => {
            selectedId = id;
        },
        close: () => setTimeout(() => resolve(selectedId === undefined ? {} : { selectedId }), 0),
    };
}

interface ContextMenuPresentation {
    /**
     * Whether this macOS can show `MenuItem.sublabel`; see `canShowMenuSublabel`. Defaults to `true`.
     */
    canShowSublabel?: boolean;
}

/**
 * `MenuItem.sublabel` (AppKit's `NSMenuItem.subtitle`) exists from macOS 14.4 and is silently dropped before it, so a
 * disabled entry's reason moves into the label on older releases instead of disappearing.
 */
export function canShowMenuSublabel(systemVersion: string): boolean {
    const [major = 0, minor = 0] = systemVersion.split('.').map(Number);
    return major > 14 || (major === 14 && minor >= 4);
}

function isDisabledFor(item: ContextMenuItemSpec | undefined, reason: string): boolean {
    return item?.type !== 'separator' && item?.enabled === false && item.disabledReason === reason;
}

/**
 * A native menu shows no tooltip for a disabled entry, so its `disabledReason` is rendered with the entry itself: as a
 * second, smaller line under the label where macOS supports a sublabel, and after an em dash in the label elsewhere. An
 * enabled entry never shows a reason, even if the Renderer sent one. Adjacent disabled entries blocked for the same
 * reason (the four Split directions, a document's three desktop actions) show it once, on the first: repeated on every
 * line it would outweigh the entries themselves. A separator starts a new group.
 */
function withDisabledReason(
    item: ContextMenuItemSpec,
    previous: ContextMenuItemSpec | undefined,
    label: string | undefined,
    { canShowSublabel = true }: ContextMenuPresentation,
): Pick<MenuItemConstructorOptions, 'enabled' | 'label' | 'sublabel'> {
    const enabled = item.enabled ?? true;
    if (enabled || !item.disabledReason || isDisabledFor(previous, item.disabledReason))
        return { label, enabled };
    if (canShowSublabel) return { label, enabled, sublabel: item.disabledReason };
    return { label: `${label ?? ''} — ${item.disabledReason}`, enabled };
}

/**
 * Converts the Renderer's plain menu description into an Electron template. Every chosen entry reports its id through
 * `onSelect`; the Renderer owns the action behind it.
 */
export function buildContextMenuTemplate(
    items: readonly ContextMenuItemSpec[],
    onSelect: (id: number) => void,
    presentation: ContextMenuPresentation = {},
): MenuItemConstructorOptions[] {
    return items.map((item, index): MenuItemConstructorOptions => {
        if (item.type === 'separator') return { type: 'separator' };
        const previous = items[index - 1];
        if (item.type === 'submenu')
            return {
                ...withDisabledReason(item, previous, item.label, presentation),
                submenu: buildContextMenuTemplate(item.submenu ?? [], onSelect, presentation),
            };
        const id = item.id!;
        const hint = shortcutHint(item.shortcut);
        return {
            ...withDisabledReason(
                item,
                previous,
                hint.label ? `${item.label} [${hint.label}]` : item.label,
                presentation,
            ),
            ...(hint.accelerator && {
                accelerator: hint.accelerator,
                /**
                 * The shortcut is a hint about the command's own binding, which the Renderer already dispatches. A
                 * registered accelerator would fire the entry a second time while the menu is open.
                 */
                registerAccelerator: false,
            }),
            click: () => onSelect(id),
        };
    });
}

/**
 * A single chord renders as a native right-aligned accelerator. A chord sequence (`cmd+k cmd+s`) has no accelerator
 * form, so it is appended to the label the same way the application menu and VS Code present it.
 */
function shortcutHint(shortcut: string | undefined): { accelerator?: string; label?: string } {
    if (!shortcut) return {};
    if (shortcutLeadingChord(shortcut)) return { label: formatShortcut(shortcut) };
    return { accelerator: electronAccelerator(shortcut) };
}

/**
 * Pops the menu and resolves with the chosen id, or with no selection, only once the menu has closed. The Renderer's
 * action often moves focus (Rename and New File open an inline input); delivered at click time it would run while the
 * menu still owns the keyboard, and the menu handing focus back to the window as it closes could then take it from that
 * input (https://github.com/tjx666/caxri/issues/1348). A click therefore only records the id, and the close `callback`
 * delivers it one macrotask later: Electron already posts that callback after the chosen item's action, and the extra
 * turn keeps the click first even if AppKit reports the close before dispatching it.
 */
export function showContextMenu(
    window: BrowserWindow,
    { items, position }: ContextMenuParameters,
    {
        isE2E = process.env.CAXRI_E2E === '1',
        systemVersion,
    }: {
        isE2E?: boolean;
        /**
         * Test seam for `process.getSystemVersion()`, which only an Electron process provides.
         */
        systemVersion?: string;
    } = {},
): Promise<ContextMenuResult> {
    return new Promise((resolve) => {
        const outcome = menuOutcome(resolve);
        if (isE2E) {
            void e2eScope.caxriE2EContextMenu?.choose();
            const probe: E2EContextMenuProbe = {
                items,
                choose: async (id, { refocusOnClose = false } = {}) => {
                    if (e2eScope.caxriE2EContextMenu === probe)
                        e2eScope.caxriE2EContextMenu = undefined;
                    const refocus =
                        refocusOnClose &&
                        window.webContents.executeJavaScript(REFOCUS_ON_CLOSE_SCRIPT);
                    if (id !== undefined) outcome.select(id);
                    await refocus;
                    outcome.close();
                },
            };
            e2eScope.caxriE2EContextMenu = probe;
            return;
        }
        const canShowSublabel = canShowMenuSublabel(systemVersion ?? process.getSystemVersion());
        const menu = Menu.buildFromTemplate(
            buildContextMenuTemplate(items, outcome.select, { canShowSublabel }),
        );
        /**
         * Renderer coordinates are CSS pixels; `popup` takes window DIPs. The two differ by the page zoom factor, which
         * only Main can read reliably.
         */
        const zoomFactor = window.webContents.getZoomFactor();
        menu.popup({
            window,
            ...(position && {
                x: Math.round(position.x * zoomFactor),
                y: Math.round(position.y * zoomFactor),
            }),
            callback: outcome.close,
        });
    });
}
