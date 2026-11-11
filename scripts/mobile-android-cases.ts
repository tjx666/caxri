import { collectAndroidCases } from './mobile-android-case-collector';

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
     * `granted` gives the app photo library access for this case, so the add sheet shows recent photos. Every other
     * case declines it, so the sheet's first-open permission prompt never covers the scenario.
     */
    mediaLibrary?: 'granted';
    /**
     * `live` turns the batch's reduced motion off for this case alone, so a recording shows real animation. UIAutomator
     * cannot read a screen that keeps animating, so such a case avoids semantics while it moves.
     */
    motion?: 'live';
    recordingOwner: 'adapter' | 'scenario';
    scenario: string;
}

/**
 * Every case registers itself: each `mobile-android-case-definitions/<group>.ts` exports its own definitions, so adding
 * a case never edits a shared list.
 */
const allAndroidCases = await collectAndroidCases();

export type MobileAndroidAcceptanceCaseId = `MOB-${string}`;
export type MobileAndroidAcceptanceScenario = string;

export function mobileAndroidAcceptanceCase(caseId: string): {
    appLocale?: MobileAndroidAppLocale;
    desktopProfile: 'managed-by-isolated-e2e' | 'not-required';
    media: MobileAndroidMediaType[];
    mediaLibrary?: 'granted';
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
        ...('mediaLibrary' in definition && { mediaLibrary: definition.mediaLibrary }),
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
