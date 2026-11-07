import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, concludeScenario } from './mobile-agent-actions-scenarios';
import {
    checkBounds,
    hasCheck,
    isReachedWithin,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import type { MobileSemanticNode } from './mobile-android';
import {
    adbShell,
    mobileDisplayState,
    mobileSemantics,
    observeMobileNode,
    restoreMobileDisplayState,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import { seedMobileChangesFixture } from './mobile-changes-fixture';
import { conversationBaselineRecords } from './mobile-conversation-transcript';

/**
 * The previous header's tabs, which the side panel button replaces.
 */
const HEADER_TABS = [
    'session-segment-conversation',
    'session-segment-terminal',
    'session-segment-changes',
    'session-segment-panel-caxri.files',
] as const;

const isSelected = (nodes: readonly MobileSemanticNode[], id: string): boolean =>
    nodes.some(({ checkId, selected }) => checkId === id && selected);

/**
 * Whether the header shows the side panel button and none of the previous tabs. Only meaningful while the side panel is
 * closed, since its own tabs reuse the Changes and Files ids.
 */
const hasPanelHeader = (nodes: readonly MobileSemanticNode[]): boolean =>
    hasCheck(nodes, 'session-panel-button') && HEADER_TABS.every((tab) => !hasCheck(nodes, tab));

/**
 * Whether the Changes list shows exactly the fixture's three changed files.
 */
const hasThreeChanges = (nodes: readonly MobileSemanticNode[]): boolean =>
    hasCheck(nodes, 'changes-file-row-2') && !hasCheck(nodes, 'changes-file-row-3');

/**
 * Whether the header's Changes badge reads `3` within a few seconds; the badge lands once the Session's changes load.
 */
const isBadgeThree = async (serial: string): Promise<boolean> => {
    try {
        await waitForMobile(
            () => observeMobileNode(serial, 'changes-count', { kind: 'equals', value: '3' }),
            (node) => node.textMatches === true,
            15_000,
        );
        return true;
    } catch {
        return false;
    }
};

/**
 * Pairs the phone with the synthetic PTY Agent Session that has a Conversation and three changed files, opens it on its
 * Conversation, and runs `step` with the opened Session's semantics. A tablet run switches the emulator to a wide
 * tablet display first and restores it afterwards.
 */
async function withChangesSession(
    environment: MobileAgentScenarioEnvironment,
    isTablet: boolean,
    step: (opened: MobileSemanticNode[]) => Promise<void>,
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        mode: 'conversation',
        seedProject: (root) => seedMobileChangesFixture(root, 'standard'),
        serial,
    });
    let originalDisplay: Awaited<ReturnType<typeof mobileDisplayState>> | undefined;
    try {
        if (!fixture.appendTranscript)
            throw new Error('Synthetic Conversation fixture is unavailable');
        await fixture.appendTranscript(conversationBaselineRecords());
        await fixture.pair();
        const sessionId = fixture.allowedSessionId;
        if (!sessionId) throw new Error('Synthetic Changes Session is unavailable');
        if (isTablet) {
            originalDisplay = await mobileDisplayState(serial);
            await adbShell(serial, ['wm', 'size', '2560x1600']);
            await adbShell(serial, ['wm', 'density', '240']);
            await adbShell(serial, ['am', 'force-stop', 'com.caxri.mobile']);
            await adbShell(serial, ['am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
            /**
             * The Session list pages by Project, and the semantics keep only the first node per id. On the wide layout
             * that first row belongs to the Project's page, parked off screen beside the "All" page, so its bounds are
             * empty and the tap helper refuses it. Showing the Project's page brings that row on screen.
             */
            const projectFilter = `project-filter-${fixture.allowedProjectId}`;
            await waitForCheck(serial, projectFilter, 60_000);
            await tapMobileCheck(serial, projectFilter);
            await waitForMobile(
                () => mobileSemantics(serial),
                (nodes) => checkBounds(nodes, `session-row-${sessionId}`) !== undefined,
            );
        }
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        const opened = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, 'conversation-view') &&
                (hasCheck(nodes, 'session-panel-button') ||
                    hasCheck(nodes, 'session-segment-changes')),
            60_000,
        );
        await step(opened);
    } finally {
        try {
            if (originalDisplay) await restoreMobileDisplayState(serial, originalDisplay);
        } finally {
            await fixture.stop();
        }
    }
}

/**
 * Captures the previous header's Changes tab so a baseline round shows what the side panel replaces, then fails.
 */
async function failOnTabbedHeader(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
    label: string,
): Promise<never> {
    await tapMobileCheck(environment.serial, 'session-segment-changes');
    await waitForCheck(environment.serial, 'changes-file-row-0');
    await capture(environment, label, artifacts);
    await concludeScenario(
        environment,
        artifacts,
        {},
        { 'the header has a side panel button': false },
    );
    throw new Error('unreachable');
}

/**
 * `MOB-SIDE-PANEL-PHONE-01` (#3752): a phone's Session header trades the Conversation, Terminal, Changes, and Files
 * tabs for one side panel button carrying the changed-file count. It opens Changes and Files in a drawer over the
 * Session, Back closes the drawer without leaving the Session, and the button reopens the tab last shown.
 */
export const executeMobileSidePanelPhoneScenario = (
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> =>
    withChangesSession(environment, false, async (opened) => {
        const { serial } = environment;
        const isBadgeRead = await isBadgeThree(serial);
        await capture(environment, 'header', artifacts);
        if (!hasCheck(opened, 'session-panel-button'))
            await failOnTabbedHeader(environment, artifacts, 'changes-tab');

        await tapMobileCheck(serial, 'session-panel-button');
        const drawer = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                isSelected(nodes, 'session-segment-changes') &&
                hasCheck(nodes, 'changes-file-row-0'),
        );
        await capture(environment, 'changes-drawer', artifacts);

        await tapMobileCheck(serial, 'session-segment-panel-caxri.files');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                isSelected(nodes, 'session-segment-panel-caxri.files') &&
                hasCheck(nodes, 'files-panel'),
        );
        await capture(environment, 'files-drawer', artifacts);

        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForNoCheck(serial, 'session-side-panel');
        const closed = await waitForCheck(serial, 'conversation-view');
        await capture(environment, 'drawer-closed', artifacts);

        await tapMobileCheck(serial, 'session-panel-button');
        const reopened = await waitForCheck(serial, 'session-side-panel');
        await tapMobileCheck(serial, 'session-side-panel-close');
        await waitForNoCheck(serial, 'session-side-panel');

        await concludeScenario(
            environment,
            artifacts,
            {},
            {
                'the header shows only the side panel button, no tabs': hasPanelHeader(opened),
                'the badge reads 3': isBadgeRead,
                'the drawer lists the three changed files': hasThreeChanges(drawer),
                'Back closes the drawer and stays in the Session': hasPanelHeader(closed),
                'the button reopens Files, the tab last shown': isSelected(
                    reopened,
                    'session-segment-panel-caxri.files',
                ),
            },
        );
    });

/**
 * `MOB-SIDE-PANEL-PHONE-02` (#3752): the header's menu switches a PTY Agent Session between its Conversation and its
 * Terminal, and the Terminal keeps the composer under it.
 */
export const executeMobileSidePanelContentSwitchScenario = (
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> =>
    withChangesSession(environment, false, async () => {
        const { serial } = environment;
        await tapMobileCheck(serial, 'session-detail-menu');
        const menu = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => hasCheck(nodes, 'session-mark-read') || hasCheck(nodes, 'session-mark-done'),
        );
        await capture(environment, 'menu', artifacts);
        const hasMenuSwitch = hasCheck(menu, 'session-show-terminal');
        if (hasMenuSwitch) {
            await tapMobileCheck(serial, 'session-show-terminal');
        } else {
            // The previous header switched through its Terminal tab instead.
            await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
            await waitForMobile(
                () => mobileSemantics(serial),
                (nodes) =>
                    !hasCheck(nodes, 'session-mark-read') && !hasCheck(nodes, 'session-mark-done'),
            );
            await tapMobileCheck(serial, 'session-segment-terminal');
        }
        // The Terminal is not captured: a frame of it would carry Terminal output into the report. Its composer is read
        // from semantics instead.
        await waitForCheck(serial, 'terminal-live-view', 60_000);
        const hasTerminalComposer = await isReachedWithin(
            serial,
            (nodes) => hasCheck(nodes, 'session-composer-input'),
            10_000,
        );
        let isBackOnConversation = false;
        if (hasMenuSwitch) {
            await tapMobileCheck(serial, 'session-detail-menu');
            await waitForCheck(serial, 'session-show-conversation');
            await tapMobileCheck(serial, 'session-show-conversation');
            isBackOnConversation = await isReachedWithin(
                serial,
                (nodes) => hasCheck(nodes, 'conversation-view'),
                30_000,
            );
        }
        await concludeScenario(
            environment,
            artifacts,
            { terminalComposer: hasTerminalComposer ? 'present' : 'absent' },
            {
                'the header menu offers the Terminal': hasMenuSwitch,
                'the Terminal keeps the composer under it': hasTerminalComposer,
                'the header menu switches back to the Conversation': isBackOnConversation,
            },
        );
    });

/**
 * `MOB-SIDE-PANEL-TABLET-01` (#3752): on a wide tablet the same header button docks the side panel to the right of the
 * Conversation, beside the Session list, with the composer still under the Conversation, and closes it again.
 */
export const executeMobileSidePanelTabletScenario = (
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> =>
    withChangesSession(environment, true, async (opened) => {
        const { serial } = environment;
        await capture(environment, 'tablet-session', artifacts);
        if (!hasCheck(opened, 'session-panel-button'))
            await failOnTabbedHeader(environment, artifacts, 'tablet-changes-tab');

        await tapMobileCheck(serial, 'session-panel-button');
        const docked = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                isSelected(nodes, 'session-segment-changes') &&
                hasCheck(nodes, 'changes-file-row-0'),
        );
        await capture(environment, 'tablet-docked', artifacts);
        const panel = checkBounds(docked, 'session-side-panel');
        const conversation = checkBounds(docked, 'conversation-view');

        await tapMobileCheck(serial, 'session-side-panel-close');
        await waitForNoCheck(serial, 'session-side-panel');
        const closed = await waitForCheck(serial, 'conversation-view');
        await capture(environment, 'tablet-closed', artifacts);

        await concludeScenario(
            environment,
            artifacts,
            {},
            {
                'the tablet header shows only the side panel button, no tabs':
                    hasPanelHeader(opened),
                'the panel docks right of the Conversation':
                    panel !== undefined &&
                    conversation !== undefined &&
                    panel.left >= conversation.right,
                'the Session list, Conversation, and composer stay beside the panel':
                    hasCheck(docked, 'session-list') && hasCheck(docked, 'session-composer-input'),
                'the panel lists the three changed files': hasThreeChanges(docked),
                'closing leaves the Session list and Conversation':
                    hasCheck(closed, 'session-list') && hasPanelHeader(closed),
            },
        );
    });
