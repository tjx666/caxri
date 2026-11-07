import { hasCheck, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { adbShell, mobileSemantics, tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * A tab of the Session side panel: `changes`, or the id of a Project view such as `caxri.files` or
 * `caxri.project-status`.
 */
export type SessionSideTab = string;

/**
 * The check id of a side panel tab: `session-segment-changes`, or `session-segment-panel-<panelId>` for a Project view.
 */
export const sessionSideTabCheckId = (tab: SessionSideTab): string =>
    tab === 'changes' ? 'session-segment-changes' : `session-segment-panel-${tab}`;

/**
 * Opens the Session side panel on `tab` and waits until that tab is selected. The header's `session-panel-button` opens
 * the panel on the side tab the Session last showed (Changes when none), so the tab is tapped only when another one is
 * selected. A panel that is already open is not toggled shut. On a phone the panel is a drawer that hides the header,
 * body, and composer from semantics until it closes; on a `tablet-wide` layout it docks beside them.
 */
export async function openSessionSidePanel(serial: string, tab: SessionSideTab): Promise<void> {
    const tabId = sessionSideTabCheckId(tab);
    // A Session row tap may return before the detail mounts; its header button or the open panel proves it did.
    const detail = await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => hasCheck(nodes, 'session-side-panel') || hasCheck(nodes, 'session-panel-button'),
    );
    if (!hasCheck(detail, 'session-side-panel')) {
        await tapMobileCheck(serial, 'session-panel-button');
        await waitForCheck(serial, 'session-side-panel');
    }
    // A Project view tab appears once the Session's panels have loaded.
    const nodes = await waitForMobile(
        () => mobileSemantics(serial),
        (current) => hasCheck(current, tabId),
    );
    if (nodes.some(({ checkId, selected }) => checkId === tabId && selected)) return;
    await tapMobileCheck(serial, tabId);
    await waitForMobile(
        () => mobileSemantics(serial),
        (current) => current.some(({ checkId, selected }) => checkId === tabId && selected),
    );
}

/**
 * Closes the Session side panel through its close button, which stays reachable when the phone scrim is not in
 * semantics, and waits until the panel is gone and the header's `session-panel-button` is back. Does nothing while the
 * panel is closed.
 */
export async function closeSessionSidePanel(serial: string): Promise<void> {
    if (!hasCheck(await mobileSemantics(serial), 'session-side-panel')) return;
    await tapMobileCheck(serial, 'session-side-panel-close');
    await waitForNoCheck(serial, 'session-side-panel');
    await waitForCheck(serial, 'session-panel-button');
}

/**
 * Asserts that the header menu offers no switch between Conversation and Terminal, as a Chat Session or a plain shell
 * has a single content. Opens the menu, reads it, and dismisses it with Back.
 */
export async function expectNoSessionContentSwitch(serial: string): Promise<void> {
    await tapMobileCheck(serial, 'session-detail-menu');
    const menu = await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => hasCheck(nodes, 'session-mark-read'),
    );
    for (const item of ['session-show-terminal', 'session-show-conversation'])
        if (hasCheck(menu, item)) throw new Error(`The Session menu offers ${item}`);
    await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
    await waitForNoCheck(serial, 'session-mark-read');
}

/**
 * Shows a PTY Agent Session's `terminal` or `conversation` content. The side panel closes first, because it is not a
 * content segment and hides the header on a phone. The header's menu (`session-detail-menu`) then holds
 * `session-show-<content>` only while that content is not on screen, so the item is tapped when present and the menu is
 * dismissed with Back when absent. A Chat Session or a plain shell has a single content and no such item.
 */
export async function showSessionContent(
    serial: string,
    content: 'terminal' | 'conversation',
): Promise<void> {
    // A Session row tap may return before the detail mounts. An open phone drawer hides the header's menu, so the panel
    // itself also proves the detail is there.
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => hasCheck(nodes, 'session-detail-menu') || hasCheck(nodes, 'session-side-panel'),
    );
    await closeSessionSidePanel(serial);
    const item = `session-show-${content}`;
    await tapMobileCheck(serial, 'session-detail-menu');
    const nodes = await waitForMobile(
        () => mobileSemantics(serial),
        (current) =>
            hasCheck(current, item) ||
            hasCheck(current, 'session-mark-read') ||
            hasCheck(current, 'session-mark-done'),
    );
    if (hasCheck(nodes, item)) {
        await tapMobileCheck(serial, item);
        return;
    }
    await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
    await waitForNoCheck(serial, 'session-mark-read');
}
