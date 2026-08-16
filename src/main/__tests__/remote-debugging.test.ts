import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from 'electron';
import { describe, expect, it } from 'vitest';

import { enableRemoteDebugging } from '../remote-debugging';

interface FakeAppOptions {
    isPackaged?: boolean;
    switches?: string[];
    userDataPath?: string;
}

function createFakeApp(options: FakeAppOptions = {}) {
    const appended: Array<{ key: string; value?: string }> = [];
    const switches = new Set(options.switches);
    const app = {
        commandLine: {
            appendSwitch: (key: string, value?: string) => {
                appended.push({ key, value });
            },
            hasSwitch: (key: string) => switches.has(key),
        },
        getPath: () => options.userDataPath ?? mkdtempSync(join(tmpdir(), 'caxri-cdp-')),
        isPackaged: options.isPackaged ?? false,
    } as unknown as App;
    return { app, appended };
}

function writeArgvConfig(userDataPath: string, source: string): void {
    mkdirSync(join(userDataPath, 'config'), { recursive: true });
    writeFileSync(join(userDataPath, 'config', 'argv.jsonc'), source, 'utf8');
}

describe('enableRemoteDebugging', () => {
    it('exposes the default port on unpackaged launches', () => {
        const { app, appended } = createFakeApp();
        enableRemoteDebugging(app, {});
        expect(appended).toEqual([{ key: 'remote-debugging-port', value: '9223' }]);
    });

    it('honors the CAXRI_DEV_CDP_PORT override', () => {
        const { app, appended } = createFakeApp();
        enableRemoteDebugging(app, { CAXRI_DEV_CDP_PORT: '9333' });
        expect(appended).toEqual([{ key: 'remote-debugging-port', value: '9333' }]);
    });

    it.each(['remote-debugging-port', 'remote-debugging-pipe'])(
        'defers to an explicit %s switch',
        (existing) => {
            const { app, appended } = createFakeApp({ switches: [existing] });
            enableRemoteDebugging(app, {});
            expect(appended).toEqual([]);
        },
    );

    it('exposes CDP on packaged launches when no argv config exists', () => {
        const { app, appended } = createFakeApp({ isPackaged: true });
        enableRemoteDebugging(app, {});
        expect(appended).toEqual([{ key: 'remote-debugging-port', value: '9223' }]);
    });

    it('skips CDP on packaged launches when the argv config disables it', () => {
        const userDataPath = mkdtempSync(join(tmpdir(), 'caxri-cdp-'));
        writeArgvConfig(
            userDataPath,
            '{\n  // internal-testing endpoint off\n  "remoteDebugging": false,\n}',
        );
        const { app, appended } = createFakeApp({ isPackaged: true, userDataPath });
        enableRemoteDebugging(app, {});
        expect(appended).toEqual([]);
    });

    it('ignores the argv config on unpackaged launches', () => {
        const userDataPath = mkdtempSync(join(tmpdir(), 'caxri-cdp-'));
        writeArgvConfig(userDataPath, '{ "remoteDebugging": false }');
        const { app, appended } = createFakeApp({ isPackaged: false, userDataPath });
        enableRemoteDebugging(app, {});
        expect(appended).toEqual([{ key: 'remote-debugging-port', value: '9223' }]);
    });
});
