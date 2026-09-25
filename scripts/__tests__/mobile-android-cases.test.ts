import { describe, expect, it } from 'vitest';

import {
    mobileAndroidAcceptanceCase,
    parseAndroidDisplayState,
    parseMobileAndroidCaseIds,
    shouldCaptureAdapterScreenshot,
    shouldCollectAndroidVideo,
} from '../mobile-android-cases';

describe('mobile Android Acceptance cases', () => {
    it('routes frozen ids to one bounded evidence scenario', () => {
        expect(mobileAndroidAcceptanceCase('MOB-FDN-01')).toEqual({
            desktopProfile: 'not-required',
            media: ['screenshot'],
            recordingOwner: 'adapter',
            scenario: 'foundation-layout',
        });
        expect(mobileAndroidAcceptanceCase('MOB-FDN-02')).toEqual({
            desktopProfile: 'not-required',
            media: ['video'],
            recordingOwner: 'adapter',
            scenario: 'foundation-cold-start',
        });
        expect(mobileAndroidAcceptanceCase('MOB-COMPOSER-01')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot', 'video'],
            recordingOwner: 'scenario',
            scenario: 'composer-unicode-submit',
        });
        expect(mobileAndroidAcceptanceCase('MOB-PAIR-05')).toEqual({
            desktopProfile: 'not-required',
            media: [],
            recordingOwner: 'adapter',
            scenario: 'crypto-vector',
        });
        expect(mobileAndroidAcceptanceCase('MOB-COMPOSER-03')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot', 'video'],
            recordingOwner: 'scenario',
            scenario: 'composer-unknown',
        });
        expect(mobileAndroidAcceptanceCase('MOB-NEW-02')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot'],
            recordingOwner: 'adapter',
            scenario: 'new-session-launch-failure',
        });
        expect(mobileAndroidAcceptanceCase('MOB-CONV-02')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['video'],
            recordingOwner: 'scenario',
            scenario: 'conversation-follow',
        });
        expect(mobileAndroidAcceptanceCase('MOB-TERM-01')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot', 'video'],
            recordingOwner: 'scenario',
            scenario: 'terminal-observe-control',
        });
        expect(mobileAndroidAcceptanceCase('MOB-TIMELINE-01')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: [],
            recordingOwner: 'adapter',
            scenario: 'timeline-projection',
        });
        expect(mobileAndroidAcceptanceCase('MOB-CHANGES-04')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['video'],
            recordingOwner: 'scenario',
            scenario: 'changes-ask-agent-draft-send',
        });
        expect(mobileAndroidAcceptanceCase('MOB-E2E-01')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot', 'video'],
            recordingOwner: 'scenario',
            scenario: 'journey-phone',
        });
        expect(mobileAndroidAcceptanceCase('MOB-CROSS-01')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot', 'video'],
            recordingOwner: 'scenario',
            scenario: 'cross-device-new-session',
        });
        expect(mobileAndroidAcceptanceCase('MOB-PARTIAL-01')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot'],
            recordingOwner: 'scenario',
            scenario: 'partial-new-session-launch-failure',
        });
        expect(() => mobileAndroidAcceptanceCase('MOB-SEC-01')).toThrow(
            'Unsupported Android Acceptance case',
        );
    });

    it('accepts a stable ordered subset without duplicates', () => {
        expect(parseMobileAndroidCaseIds('MOB-FDN-01,MOB-COMPOSER-01')).toEqual([
            'MOB-FDN-01',
            'MOB-COMPOSER-01',
        ]);
        expect(() => parseMobileAndroidCaseIds('MOB-FDN-01,MOB-FDN-01')).toThrow(
            'Duplicate Android Acceptance case',
        );
        expect(() => parseMobileAndroidCaseIds('')).toThrow(
            'At least one Android Acceptance case is required',
        );
    });

    it('never captures a Shell fallback frame in the adapter before formal fixture preflight', () => {
        expect(shouldCaptureAdapterScreenshot('MOB-CONV-03', false)).toBe(false);
        expect(shouldCaptureAdapterScreenshot('MOB-CONV-03', true)).toBe(false);
        expect(shouldCaptureAdapterScreenshot('MOB-CONV-01', true)).toBe(true);
        expect(shouldCaptureAdapterScreenshot('MOB-CONV-01', false)).toBe(false);
        expect(shouldCaptureAdapterScreenshot('MOB-TERM-01', true)).toBe(false);
        expect(shouldCaptureAdapterScreenshot('MOB-TERM-01', false)).toBe(false);
        for (const caseId of [
            'MOB-CHANGES-01',
            'MOB-CHANGES-02',
            'MOB-CHANGES-03',
            'MOB-CHANGES-04',
        ]) {
            expect(shouldCaptureAdapterScreenshot(caseId, true)).toBe(false);
        }
        expect(shouldCaptureAdapterScreenshot('MOB-E2E-01', true)).toBe(false);
        expect(shouldCaptureAdapterScreenshot('MOB-E2E-03', true)).toBe(false);
        expect(shouldCaptureAdapterScreenshot('MOB-CROSS-01', true)).toBe(false);
        expect(shouldCaptureAdapterScreenshot('MOB-PARTIAL-01', true)).toBe(false);
    });

    it('does not pull Terminal video after blocked fixture preflight or failed scenario execution', () => {
        expect(shouldCollectAndroidVideo('MOB-TERM-01', false)).toBe(false);
        expect(shouldCollectAndroidVideo('MOB-TERM-01', true)).toBe(true);
        expect(shouldCollectAndroidVideo('MOB-CONV-02', false)).toBe(true);
        expect(shouldCollectAndroidVideo('MOB-CONV-03', true)).toBe(false);
        expect(shouldCollectAndroidVideo('MOB-E2E-01', false)).toBe(false);
        expect(shouldCollectAndroidVideo('MOB-E2E-01', true)).toBe(true);
        expect(shouldCollectAndroidVideo('MOB-CROSS-01', false)).toBe(false);
        expect(shouldCollectAndroidVideo('MOB-CROSS-01', true)).toBe(true);
    });

    it('normalizes physical and override display state for exact restoration', () => {
        expect(
            parseAndroidDisplayState({
                density: 'Physical density: 420\nOverride density: 320',
                fontScale: '1.0',
                rotation: 'SurfaceOrientation: 1',
                size: 'Physical size: 1080x2400\nOverride size: 1600x2560',
            }),
        ).toEqual({
            density: { override: 320, physical: 420 },
            fontScale: 1,
            rotation: 1,
            size: {
                override: { height: 2560, width: 1600 },
                physical: { height: 2400, width: 1080 },
            },
        });
    });

    it('reads rotation from the active Android 36 internal viewport', () => {
        expect(
            parseAndroidDisplayState({
                density: 'Physical density: 420',
                fontScale: '1.0',
                rotation:
                    'Viewport INTERNAL: displayId=0, orientation=1, logicalFrame=[0, 0, 2400, 1080], isActive=[1]',
                size: 'Physical size: 1080x2400',
            }).rotation,
        ).toBe(1);
    });
});
