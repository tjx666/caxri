import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Cases the Android runner drives itself, by scenario name in `scripts/mobile-android-built-in-scenarios.ts`, without a
 * Playwright handler: foundation layout and cold start, crypto and barcode vectors, and the adapter lifecycle.
 */
export const cases = {
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
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
