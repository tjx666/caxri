export type MobileAndroidMediaType = 'screenshot' | 'video';

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
    'MOB-PANELS-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'browse-panels',
    },
    'MOB-CHAT-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat',
    },
    'MOB-CHAT-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-tool-approval',
    },
    'MOB-CHAT-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-new-session',
    },
    'MOB-CHAT-04': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-model',
    },
    'MOB-CHAT-05': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-image',
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
} as const satisfies Record<
    string,
    {
        desktopProfile: 'managed-by-isolated-e2e' | 'not-required';
        media: readonly MobileAndroidMediaType[];
        recordingOwner: 'adapter' | 'scenario';
        scenario: string;
    }
>;

export type MobileAndroidAcceptanceCaseId = keyof typeof androidCases;
export type MobileAndroidAcceptanceScenario =
    (typeof androidCases)[MobileAndroidAcceptanceCaseId]['scenario'];

export function mobileAndroidAcceptanceCase(caseId: string): {
    desktopProfile: 'managed-by-isolated-e2e' | 'not-required';
    media: MobileAndroidMediaType[];
    recordingOwner: 'adapter' | 'scenario';
    scenario: MobileAndroidAcceptanceScenario;
} {
    if (!Object.hasOwn(androidCases, caseId)) {
        throw new Error(`Unsupported Android Acceptance case: ${caseId}`);
    }
    const definition = androidCases[caseId as MobileAndroidAcceptanceCaseId];
    return {
        desktopProfile: definition.desktopProfile,
        media: [...definition.media],
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
        !caseId.startsWith('MOB-UI-') &&
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

interface AndroidDisplayStateSource {
    density: string;
    fontScale: string;
    rotation: string;
    size: string;
}

export interface AndroidDisplayState {
    density: { override?: number; physical: number };
    fontScale: number;
    rotation: number;
    size: {
        override?: { height: number; width: number };
        physical: { height: number; width: number };
    };
}

function requiredNumber(source: string, pattern: RegExp, field: string): number {
    const value = pattern.exec(source)?.[1];
    if (!value) throw new Error(`Android ${field} state is unavailable`);
    return Number(value);
}

function size(source: string, label: 'Override' | 'Physical') {
    const match = new RegExp(String.raw`${label} size: (\d+)x(\d+)`, 'u').exec(source);
    if (!match) return;
    return { height: Number(match[2]), width: Number(match[1]) };
}

/**
 * Android 36 no longer publishes `SurfaceOrientation` in `dumpsys input`. Its fallback must stay bound to the active
 * primary internal viewport because the same output also contains inactive virtual viewports with stale orientation.
 */
function rotation(source: string): number {
    const legacy = /SurfaceOrientation:\s*(\d+)/u.exec(source)?.[1];
    const activeViewportLine = source
        .split(/\r?\n/u)
        .find(
            (line) =>
                line.includes('Viewport INTERNAL:') &&
                line.includes('displayId=0,') &&
                line.includes('isActive=[1]'),
        );
    const activeViewport = activeViewportLine
        ? /orientation=(\d+)/u.exec(activeViewportLine)?.[1]
        : undefined;
    const value = legacy ?? activeViewport;
    if (!value) throw new Error('Android rotation state is unavailable');
    return Number(value);
}

export function parseAndroidDisplayState(source: AndroidDisplayStateSource): AndroidDisplayState {
    const physicalSize = size(source.size, 'Physical');
    if (!physicalSize) throw new Error('Android physical display size is unavailable');
    const overrideDensity = /Override density: (\d+)/u.exec(source.density)?.[1];
    const overrideSize = size(source.size, 'Override');
    return {
        density: {
            ...(overrideDensity && { override: Number(overrideDensity) }),
            physical: requiredNumber(source.density, /Physical density: (\d+)/u, 'density'),
        },
        fontScale: requiredNumber(source.fontScale, /(\d+(?:\.\d+)?)/u, 'font scale'),
        rotation: rotation(source.rotation),
        size: { ...(overrideSize && { override: overrideSize }), physical: physicalSize },
    };
}
