import { collectAndroidChatCases } from './mobile-android-chat-case-collector';

export type MobileAndroidMediaType = 'screenshot' | 'video';

/**
 * The app languages an Android case can run under; the app follows the system language otherwise.
 */
export type MobileAndroidAppLocale = 'zh-CN';

export interface MobileAndroidCaseDefinition {
    /**
     * The per-app language the runner sets on the disposable emulator for this case alone and resets afterwards.
     */
    appLocale?: MobileAndroidAppLocale;
    desktopProfile: 'managed-by-isolated-e2e' | 'not-required';
    media: readonly MobileAndroidMediaType[];
    /**
     * `live` turns the batch's reduced motion off for this case alone, so a recording shows real animation. UIAutomator
     * cannot read a screen that keeps animating, so such a case avoids semantics while it moves.
     */
    motion?: 'live';
    recordingOwner: 'adapter' | 'scenario';
    scenario: string;
}

const androidCases = {
    'MOB-ATTN-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'scenario',
        scenario: 'agent-permission',
    },
    'MOB-ATTN-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'scenario',
        scenario: 'agent-question',
    },
    'MOB-COMPOSE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'scenario',
        scenario: 'agent-composer-suggestions',
    },
    'MOB-COMPOSE-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'scenario',
        scenario: 'agent-image-attachment',
    },
    'MOB-EDIT-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'file-edit-conflict',
    },
    'MOB-ACC-02': {
        desktopProfile: 'not-required',
        media: ['screenshot', 'video'],
        recordingOwner: 'adapter',
        scenario: 'adapter-lifecycle',
    },
    'MOB-FDN-01': {
        desktopProfile: 'not-required',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'foundation-layout',
    },
    'MOB-FDN-02': {
        desktopProfile: 'not-required',
        media: ['video'],
        recordingOwner: 'adapter',
        scenario: 'foundation-cold-start',
    },
    'MOB-FDN-03': {
        desktopProfile: 'not-required',
        media: [],
        recordingOwner: 'adapter',
        scenario: 'foundation-inspect',
    },
    'MOB-PAIR-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'pairing-recovery',
    },
    'MOB-PAIR-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'adapter',
        scenario: 'pairing-revocation',
    },
    'MOB-PAIR-04': {
        desktopProfile: 'not-required',
        media: [],
        recordingOwner: 'adapter',
        scenario: 'barcode-vector',
    },
    'MOB-PAIR-05': {
        desktopProfile: 'not-required',
        media: [],
        recordingOwner: 'adapter',
        scenario: 'crypto-vector',
    },
    'MOB-PAIR-CANCEL-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'pairing-cancel',
    },
    'MOB-RENDER-01': {
        desktopProfile: 'not-required',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'render-retry',
    },
    'MOB-STORAGE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'credential-storage-retry',
    },
    'MOB-STORAGE-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'composer-draft-restart',
    },
    'MOB-SESSION-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'session-states',
    },
    'MOB-SESSION-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'adapter',
        scenario: 'session-reconnect',
    },
    'MOB-SESSION-PUSH-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'session-detail-push',
    },
    'MOB-TERM-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'terminal-observe-control',
    },
    'MOB-TERM-SCROLL-FEEL-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'terminal-scroll-feel',
    },
    'MOB-TERM-SCROLLBACK-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'terminal-scrollback',
    },
    'MOB-COMPOSER-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'composer-unicode-submit',
    },
    'MOB-COMPOSER-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'composer-stop',
    },
    'MOB-COMPOSER-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'composer-unknown',
    },
    'MOB-NEW-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'new-session-create',
    },
    'MOB-NEW-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'new-session-launch-failure',
    },
    'MOB-PROJECT-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'add-nested-project',
    },
    'MOB-PROJECT-REORDER-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'reorder-project-filters',
    },
    'MOB-PANELS-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'browse-panels',
    },
    'MOB-PANELS-TREE-REFRESH-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'refresh-expanded-tree',
    },
    'MOB-CONV-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'conversation-content',
    },
    'MOB-CONV-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'scenario',
        scenario: 'conversation-follow',
    },
    'MOB-CONV-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'conversation-shell-fallback',
    },
    'MOB-CONV-04': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'conversation-tablet-font',
    },
    'MOB-CONV-05': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'conversation-open-return',
    },
    'MOB-MOTION-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'motion-tab-switch',
    },
    'MOB-MOTION-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'motion-swipe-rows',
    },
    'MOB-MOTION-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'motion-tool-detail-sheet',
    },
    'MOB-TIMELINE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: [],
        recordingOwner: 'adapter',
        scenario: 'timeline-projection',
    },
    'MOB-CHANGES-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'changes-list-and-diff',
    },
    'MOB-CHANGES-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'changes-unreviewable-placeholder',
    },
    'MOB-CHANGES-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'changes-wide-tablet-pane',
    },
    'MOB-CHANGES-04': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'scenario',
        scenario: 'changes-ask-agent-draft-send',
    },
    'MOB-CROSS-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'cross-device-new-session',
    },
    'MOB-PARTIAL-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'partial-new-session-launch-failure',
    },
    'MOB-E2E-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'journey-phone',
    },
    'MOB-E2E-02A': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'journey-background-recovery',
    },
    'MOB-E2E-02B': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'journey-network-recovery',
    },
    'MOB-E2E-02C': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'journey-desktop-revocation',
    },
    'MOB-E2E-02D': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'journey-simultaneous-terminal',
    },
    'MOB-E2E-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'journey-tablet',
    },
    'MOB-UI-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-project-tab',
    },
    'MOB-UI-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-changes',
    },
    'MOB-UI-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-offline',
    },
    'MOB-UI-04': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'conversation-shell-fallback',
    },
    'MOB-UI-05': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-project-icons',
    },
    'MOB-UI-06': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-session-management',
    },
    'MOB-UI-07': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-settings',
    },
    'MOB-UI-08': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-rename-keyboard-avoidance',
    },
    'MOB-UI-09': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-host-status',
    },
    'MOB-UI-10': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-host-status',
    },
    'MOB-SESSION-SEARCH-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-session-search',
    },
    'MOB-SESSION-SEARCH-ZH-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-session-search',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;

/**
 * Agent Chat cases (`MOB-CHAT-*`) register themselves: each `mobile-android-chat-cases/<group>.ts` exports its own
 * definitions, so adding a case never edits this shared list.
 */
const androidChatCases = await collectAndroidChatCases();

for (const caseId of Object.keys(androidChatCases)) {
    if (Object.hasOwn(androidCases, caseId)) {
        throw new Error(`Duplicate Android Acceptance case: ${caseId}`);
    }
}

const allAndroidCases: Record<string, MobileAndroidCaseDefinition> = {
    ...androidCases,
    ...androidChatCases,
};

export type MobileAndroidAcceptanceCaseId = keyof typeof androidCases | `MOB-CHAT-${string}`;
export type MobileAndroidAcceptanceScenario = string;

export function mobileAndroidAcceptanceCase(caseId: string): {
    appLocale?: MobileAndroidAppLocale;
    desktopProfile: 'managed-by-isolated-e2e' | 'not-required';
    media: MobileAndroidMediaType[];
    motion?: 'live';
    recordingOwner: 'adapter' | 'scenario';
    scenario: MobileAndroidAcceptanceScenario;
} {
    if (!Object.hasOwn(allAndroidCases, caseId)) {
        throw new Error(`Unsupported Android Acceptance case: ${caseId}`);
    }
    const definition = allAndroidCases[caseId];
    return {
        ...('appLocale' in definition && { appLocale: definition.appLocale }),
        desktopProfile: definition.desktopProfile,
        media: [...definition.media],
        ...('motion' in definition && { motion: definition.motion }),
        recordingOwner: definition.recordingOwner,
        scenario: definition.scenario,
    };
}

/**
 * A Terminal fixture frame is owned by its scenario after the formal fixture preflight.
 */
export function shouldCaptureAdapterScreenshot(caseId: string, isLifecycleReady: boolean): boolean {
    const definition = mobileAndroidAcceptanceCase(caseId);
    return (
        isLifecycleReady &&
        definition.media.includes('screenshot') &&
        definition.scenario !== 'conversation-shell-fallback' &&
        definition.scenario !== 'terminal-observe-control' &&
        definition.scenario !== 'terminal-scroll-feel' &&
        definition.scenario !== 'terminal-scrollback' &&
        !caseId.startsWith('MOB-CHANGES-') &&
        !caseId.startsWith('MOB-MOTION-') &&
        !definition.scenario.startsWith('ui-audit-') &&
        !caseId.startsWith('MOB-E2E-') &&
        caseId !== 'MOB-CROSS-01' &&
        caseId !== 'MOB-PARTIAL-01'
    );
}

/**
 * Failed Terminal preflight and scenario execution cannot leave a report-bound recording.
 */
export function shouldCollectAndroidVideo(caseId: string, isScenarioSucceeded: boolean): boolean {
    const definition = mobileAndroidAcceptanceCase(caseId);
    return (
        definition.media.includes('video') &&
        (![
            'terminal-observe-control',
            'terminal-scroll-feel',
            'terminal-scrollback',
            'journey-phone',
            'cross-device-new-session',
        ].includes(definition.scenario) ||
            isScenarioSucceeded)
    );
}

export function parseMobileAndroidCaseIds(
    source: string | undefined,
): MobileAndroidAcceptanceCaseId[] {
    const values = (source ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    if (values.length === 0) throw new Error('At least one Android Acceptance case is required');
    const seen = new Set<string>();
    return values.map((caseId) => {
        mobileAndroidAcceptanceCase(caseId);
        if (seen.has(caseId)) throw new Error(`Duplicate Android Acceptance case: ${caseId}`);
        seen.add(caseId);
        return caseId as MobileAndroidAcceptanceCaseId;
    });
}
