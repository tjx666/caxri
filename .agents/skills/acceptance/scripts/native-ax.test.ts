import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
    NATIVE_AX_SOURCE_PATH,
    nativeAxArguments,
    nativeAxCacheKey,
    parseNativeAxResult,
} from './native-ax';

describe('Acceptance native Accessibility transport', () => {
    it('builds a source, toolchain, platform, and architecture-specific cache key', () => {
        const baseline = nativeAxCacheKey({
            architecture: 'arm64',
            platform: 'darwin',
            source: 'source',
            toolchain: 'swift-1',
        });

        expect(baseline).toHaveLength(64);
        expect(
            nativeAxCacheKey({
                architecture: 'arm64',
                platform: 'darwin',
                source: 'source',
                toolchain: 'swift-2',
            }),
        ).not.toBe(baseline);
    });

    it('uses structured argv for one owned PID and one semantic target', () => {
        expect(
            nativeAxArguments('open-panel-select', {
                button: 'Open',
                path: '/fixture.json',
                pid: 42,
                timeoutMs: 5000,
                title: 'Import Theme',
            }),
        ).toEqual([
            'open-panel-select',
            '--pid',
            '42',
            '--button',
            'Open',
            '--title',
            'Import Theme',
            '--path',
            '/fixture.json',
            '--timeout-ms',
            '5000',
        ]);
    });

    it('parses one exact structured native response', () => {
        expect(
            parseNativeAxResult(
                '{"elapsedMs":56,"matchCount":1,"ok":true,"ownerPid":42,"role":"AXSheet","title":"Open"}\n',
            ),
        ).toEqual({
            elapsedMs: 56,
            matchCount: 1,
            ok: true,
            ownerPid: 42,
            role: 'AXSheet',
            title: 'Open',
        });
    });

    it('rejects log noise or malformed response shapes', () => {
        expect(() => parseNativeAxResult('debug\n{"ok":true}\n')).toThrow('exactly one JSON line');
        expect(() => parseNativeAxResult('{"ok":true}\n')).toThrow('invalid shape');
    });

    it('uses direct bounded AX calls without AppleScript, global keyboard events, or coordinates', async () => {
        const source = await readFile(NATIVE_AX_SOURCE_PATH, 'utf8');

        expect(source).toContain('AXIsProcessTrusted()');
        expect(source).toContain('AXUIElementSetMessagingTimeout');
        expect(source).toContain('CGSSessionScreenIsLocked');
        expect(source).toContain('kAXDefaultButtonAttribute');
        expect(source).toContain('kAXSelectedAttribute');
        expect(source).toContain('kAXSelectedChildrenAttribute');
        expect(source).toContain('panelMaxElements = 2_048');
        expect(source).not.toContain('System Events');
        expect(source).not.toContain('CGEventPost');
        expect(source).not.toContain('keystroke');
    });
});
