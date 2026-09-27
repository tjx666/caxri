import process from 'node:process';

import type { ContextMenuItemSpec, MainRequest, MethodResult } from '@caxri/protocol';
import { formatShortcut, shortcutLeadingChord } from '@caxri/protocol';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { Menu } from 'electron';

import { electronAccelerator } from './menu-accelerator';

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
    choose(id?: number): void;
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
 * Converts the Renderer's plain menu description into an Electron template. Every chosen entry reports its id through
 * `onSelect`; the Renderer owns the action behind it.
 */
export function buildContextMenuTemplate(
    items: readonly ContextMenuItemSpec[],
    onSelect: (id: number) => void,
): MenuItemConstructorOptions[] {
    return items.map((item): MenuItemConstructorOptions => {
        if (item.type === 'separator') return { type: 'separator' };
        if (item.type === 'submenu')
            return {
                label: item.label,
                enabled: item.enabled ?? true,
                submenu: buildContextMenuTemplate(item.submenu ?? [], onSelect),
            };
        const id = item.id!;
        const hint = shortcutHint(item.shortcut);
        return {
            label: hint.label ? `${item.label} [${hint.label}]` : item.label,
            enabled: item.enabled ?? true,
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
 * Pops the menu and resolves with the chosen id, or with no selection once the menu closes without a choice. A click
 * resolves immediately rather than being read back in the close `callback`, and the close answer waits one macrotask:
 * AppKit reports the menu closed before it dispatches the chosen item's action, so reading the choice from the callback
 * alone could miss it.
 */
export function showContextMenu(
    window: BrowserWindow,
    { items, position }: ContextMenuParameters,
    { isE2E = process.env.CAXRI_E2E === '1' }: { isE2E?: boolean } = {},
): Promise<ContextMenuResult> {
    return new Promise((resolve) => {
        if (isE2E) {
            e2eScope.caxriE2EContextMenu?.choose();
            const probe: E2EContextMenuProbe = {
                items,
                choose: (id) => {
                    if (e2eScope.caxriE2EContextMenu === probe)
                        e2eScope.caxriE2EContextMenu = undefined;
                    resolve(id === undefined ? {} : { selectedId: id });
                },
            };
            e2eScope.caxriE2EContextMenu = probe;
            return;
        }
        const menu = Menu.buildFromTemplate(
            buildContextMenuTemplate(items, (id) => resolve({ selectedId: id })),
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
            callback: () => setTimeout(() => resolve({}), 0),
        });
    });
}
