export type MobileAndroidMediaType = 'screenshot' | 'video';

const androidCases = {
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
    'MOB-TERM-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'adapter',
        scenario: 'terminal-observe-control',
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
