import { describe, expect, it } from 'vitest';

import {
    mobileAndroidAcceptanceCase,
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
        expect(mobileAndroidAcceptanceCase('MOB-PAIR-04')).toEqual({
            desktopProfile: 'not-required',
            media: [],
            recordingOwner: 'adapter',
            scenario: 'barcode-vector',
        });
        expect(mobileAndroidAcceptanceCase('MOB-RENDER-01').scenario).toBe('render-retry');
        expect(mobileAndroidAcceptanceCase('MOB-STORAGE-01').scenario).toBe(
            'credential-storage-retry',
        );
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
        expect(mobileAndroidAcceptanceCase('MOB-PROJECT-01')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot'],
            recordingOwner: 'scenario',
            scenario: 'add-nested-project',
        });
        expect(mobileAndroidAcceptanceCase('MOB-PANELS-01')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot'],
            recordingOwner: 'scenario',
            scenario: 'browse-panels',
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
        expect(mobileAndroidAcceptanceCase('MOB-TERM-SCROLL-FEEL-01')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot', 'video'],
            recordingOwner: 'scenario',
            scenario: 'terminal-scroll-feel',
        });
        expect(mobileAndroidAcceptanceCase('MOB-TERM-SCROLLBACK-01')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot', 'video'],
            recordingOwner: 'scenario',
            scenario: 'terminal-scrollback',
        });
        expect(mobileAndroidAcceptanceCase('MOB-MOTION-02')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot', 'video'],
            recordingOwner: 'scenario',
            scenario: 'motion-swipe-rows',
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

    it('applies a live-motion or app-language override only to the case that declares it', () => {
        expect(mobileAndroidAcceptanceCase('MOB-CHAT-15')).toEqual({
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot', 'video'],
            motion: 'live',
            recordingOwner: 'scenario',
            scenario: 'agent-chat-shimmer',
        });
        expect(mobileAndroidAcceptanceCase('MOB-CHAT-18')).toEqual({
            appLocale: 'zh-CN',
            desktopProfile: 'managed-by-isolated-e2e',
            media: ['screenshot'],
            recordingOwner: 'scenario',
            scenario: 'agent-chat-chinese-locale',
        });
        expect(mobileAndroidAcceptanceCase('MOB-CHAT-13')).not.toHaveProperty('motion');
        expect(mobileAndroidAcceptanceCase('MOB-CHAT-13')).not.toHaveProperty('appLocale');
        expect(
            parseMobileAndroidCaseIds(
                'MOB-CHAT-13,MOB-CHAT-14,MOB-CHAT-15,MOB-CHAT-16,MOB-CHAT-17,MOB-CHAT-18',
            ),
        ).toHaveLength(6);
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
        expect(shouldCaptureAdapterScreenshot('MOB-TERM-SCROLL-FEEL-01', true)).toBe(false);
        expect(shouldCaptureAdapterScreenshot('MOB-TERM-SCROLLBACK-01', true)).toBe(false);
        for (const caseId of [
            'MOB-MOTION-01',
            'MOB-MOTION-02',
            'MOB-MOTION-03',
            'MOB-CHANGES-01',
            'MOB-CHANGES-02',
            'MOB-CHANGES-03',
            'MOB-CHANGES-04',
            'MOB-UI-01',
            'MOB-UI-02',
            'MOB-UI-03',
            'MOB-UI-04',
            'MOB-UI-05',
            'MOB-UI-06',
            'MOB-UI-07',
            'MOB-UI-08',
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
        expect(shouldCollectAndroidVideo('MOB-TERM-SCROLL-FEEL-01', false)).toBe(false);
        expect(shouldCollectAndroidVideo('MOB-TERM-SCROLL-FEEL-01', true)).toBe(true);
        expect(shouldCollectAndroidVideo('MOB-TERM-SCROLLBACK-01', false)).toBe(false);
        expect(shouldCollectAndroidVideo('MOB-TERM-SCROLLBACK-01', true)).toBe(true);
        expect(shouldCollectAndroidVideo('MOB-MOTION-02', false)).toBe(true);
        expect(shouldCollectAndroidVideo('MOB-CONV-02', false)).toBe(true);
        expect(shouldCollectAndroidVideo('MOB-CONV-03', true)).toBe(false);
        expect(shouldCollectAndroidVideo('MOB-E2E-01', false)).toBe(false);
        expect(shouldCollectAndroidVideo('MOB-E2E-01', true)).toBe(true);
        expect(shouldCollectAndroidVideo('MOB-CROSS-01', false)).toBe(false);
        expect(shouldCollectAndroidVideo('MOB-CROSS-01', true)).toBe(true);
    });
});
