import { resolve } from 'node:path';

import { chromium } from 'playwright';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import type { MobileClientContextValue } from '../../src/features/connection/use-mobile-client-controller';
import type { useLiveTerminal } from '../../src/features/terminal/use-live-terminal';

type FixtureScope = typeof globalThis & {
    fixture: {
        client: MobileClientContextValue;
        observation: () => void;
        renders: number;
        run: () => Promise<string[]>;
        subscriptions: number;
        terminal: ReturnType<typeof useLiveTerminal>;
        unsubscribed: number;
    };
};

const root = resolve(import.meta.dirname, '../..');

/**
 * Exercise the real hooks and xterm parser; only native adapters and the remote peer are fixtures.
 */
async function browserBundle(entry: string, modules: Record<string, string> = {}): Promise<string> {
    const entryId = resolve(root, 'fixture-entry.js');
    const sources = { [entryId]: entry, ...modules };
    const result = await build({
        configFile: false,
        root,
        logLevel: 'silent',
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        resolve: {
            alias: {
                '@caxri/mobile-transport': resolve(
                    root,
                    '../../packages/mobile-transport/src/index.ts',
                ),
                '@caxri/protocol': resolve(root, '../../packages/protocol/src/index.ts'),
                '@caxri/utils': resolve(root, '../../packages/utils/src/index.ts'),
            },
        },
        plugins: [
            {
                name: 'mobile-runtime-fixtures',
                enforce: 'pre',
                resolveId: (id) => (Object.hasOwn(sources, id) ? `\0${id}` : undefined),
                load: (id) => (id.startsWith('\0') ? sources[id.slice(1)] : undefined),
            },
        ],
        build: {
            write: false,
            minify: false,
            lib: { entry: entryId, name: 'MobileFixture', formats: ['iife'] },
        },
    });
    const outputs = Array.isArray(result) ? result : [result];
    for (const output of outputs) {
        if (!('output' in output)) continue;
        const chunk = output.output.find((item) => item.type === 'chunk');
        if (chunk?.type === 'chunk') return chunk.code;
    }
    throw new Error('The browser fixture did not produce JavaScript');
}

describe('mobile runtime browser boundaries', () => {
    it('keeps newer pairing and Forget authoritative over delayed pairing results', async () => {
        const code = await browserBundle(
            `
            import { createElement } from 'react';
            import { createRoot } from 'react-dom/client';
            import { useMobileClientController } from '${root}/src/features/connection/use-mobile-client-controller.ts';
            globalThis.fixture = { saved: null, delayed: {}, closed: [] };
            function Harness() {
                globalThis.fixture.client = useMobileClientController();
                return null;
            }
            globalThis.fixture.run = async () => {
                const f = globalThis.fixture;
                const old = f.client.pair('A').catch(() => {});
                await f.client.pair('B');
                f.delayed.A();
                await old;
                await new Promise(requestAnimationFrame);
                const result = [f.client.hostId, JSON.parse(f.saved).serverId, String(f.closed.includes('A'))];
                const pending = f.client.pair('C').catch(() => {});
                await f.client.forgetDevice();
                f.delayed.C();
                await pending;
                await new Promise(requestAnimationFrame);
                return [...result, f.client.status, String(f.saved), String(f.closed.includes('C'))];
            };
            createRoot(document.getElementById('root')).render(createElement(Harness));
        `,
            {
                'react-native': `export const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };`,
                'expo-device': `export const modelName = 'Fixture phone';`,
                'expo-network': `export const addNetworkStateListener = () => ({ remove() {} });`,
                './expo-credential-store': `
                    import { createMobileCredentialStore } from '${root}/src/features/connection/credential-store.ts';
                    export const expoMobileCredentialStore = createMobileCredentialStore({
                        getItemAsync: async () => globalThis.fixture.saved,
                        setItemAsync: async (_, value) => { globalThis.fixture.saved = value; },
                        deleteItemAsync: async () => { globalThis.fixture.saved = null; }
                    });
                `,
                './expo-mobile-gateway-runtime': `export const expoMobileGatewayRuntime = {};`,
                './mobile-gateway-client': `
                    export class MobileGatewayRequestError extends Error {}
                    export class MobileGatewayTimeoutError extends Error {}
                    export class MobileReconnectError extends Error {}
                    export class MobileVersionMismatchError extends Error {}
                    export const reconnectMobileGateway = async () => { throw new Error('Unexpected reconnect'); };
                    export const pairMobileGateway = async (input) => {
                        const name = input.pairingLink;
                        const connection = { close: () => globalThis.fixture.closed.push(name),
                            setForeground() {}, onObservation: () => () => {}, onTermination: () => () => {} };
                        try {
                            if (name !== 'B') await new Promise(resolve => { globalThis.fixture.delayed[name] = resolve; });
                            const credential = { version: 1, addresses: ['127.0.0.1'], port: 42131,
                                serverId: name, deviceId: 'device_' + '01'.repeat(16), generation: 1, credential: 'ab'.repeat(32) };
                            await input.store.save(credential, input.isCurrent);
                            return { credential, connection };
                        } catch (error) { connection.close(); throw error; }
                    };
                `,
            },
        );
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            await page.setContent('<div id="root"></div>');
            await page.addScriptTag({ content: code });
            await page.waitForFunction(
                () =>
                    Reflect.has((globalThis as FixtureScope).fixture, 'client') &&
                    (globalThis as FixtureScope).fixture.client.status === 'unpaired',
            );
            expect(await page.evaluate(() => (globalThis as FixtureScope).fixture.run())).toEqual([
                'B',
                'B',
                'true',
                'unpaired',
                'null',
                'true',
            ]);
        } finally {
            await browser.close();
        }
    });

    it('reacquires a Terminal snapshot after a WebView document restarts', async () => {
        const code = await browserBundle(
            `
            import { createElement } from 'react';
            import { createRoot } from 'react-dom/client';
            import { useLiveTerminal } from '${root}/src/features/terminal/use-live-terminal.ts';
            globalThis.fixture = { subscriptions: 0, unsubscribed: 0 };
            const injectScript = () => {};
            function Harness() {
                globalThis.fixture.terminal = useLiveTerminal({ injectScript, isConnected: true,
                    isStopped: false, role: 'control', terminalId: 'terminal-fixture', visible: true });
                return null;
            }
            createRoot(document.getElementById('root')).render(createElement(Harness));
        `,
            {
                'expo-clipboard': `export const getStringAsync = async () => '';`,
                '../connection/mobile-gateway-client': `export class MobileGatewayRequestError extends Error {}`,
                '../connection/mobile-client-provider': `
                const context = { connectionEpoch: 1, subscriptionAvailable: true,
                    request: async () => null,
                    subscribe: async (_, listener) => {
                        const id = ++globalThis.fixture.subscriptions;
                        const snapshot = { terminalId: 'terminal-fixture', encodingVersion: 1,
                            cols: 80, rows: 24, lineCount: 1, byteCount: 2, payload: 'hi', updatedAt: 1 };
                        const chunkHex = Array.from(new TextEncoder().encode(JSON.stringify(snapshot)),
                            byte => byte.toString(16).padStart(2, '0')).join('');
                        listener({ type: 'stream', kind: 'terminal.snapshot', generation: 1,
                            nextHostSequence: 1, chunkIndex: 0, chunkCount: 1, chunkHex });
                        return { subscriptionId: 'subscription-' + id,
                            unsubscribe: async () => { globalThis.fixture.unsubscribed++; } };
                    }
                };
                export const useMobileClient = () => context;
            `,
            },
        );
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            await page.setContent('<div id="root"></div>');
            await page.addScriptTag({ content: code });
            await page.waitForFunction(() =>
                Reflect.has((globalThis as FixtureScope).fixture, 'terminal'),
            );
            const ready = JSON.stringify({
                version: 1,
                terminalId: 'terminal-fixture',
                type: 'ready',
            });
            await page.evaluate(
                (message) =>
                    (globalThis as FixtureScope).fixture.terminal.onWebviewMessage(message),
                ready,
            );
            await page.waitForFunction(
                () => (globalThis as FixtureScope).fixture.subscriptions === 1,
            );
            await page.evaluate(
                (message) =>
                    (globalThis as FixtureScope).fixture.terminal.onWebviewMessage(message),
                ready,
            );
            await page.waitForFunction(
                () => (globalThis as FixtureScope).fixture.subscriptions === 2,
                undefined,
                { timeout: 3_000 },
            );
            expect(
                await page.evaluate(() => (globalThis as FixtureScope).fixture.unsubscribed),
            ).toBe(1);
            await page.evaluate(() =>
                (globalThis as FixtureScope).fixture.terminal.onWebviewTerminated(),
            );
            await page.waitForFunction(
                () => (globalThis as FixtureScope).fixture.unsubscribed === 2,
            );
            const stopped = await page.evaluate(() => ({
                state: (globalThis as FixtureScope).fixture.terminal.state,
                subscriptions: (globalThis as FixtureScope).fixture.subscriptions,
            }));
            expect(stopped).toEqual({ state: 'loading', subscriptions: 2 });
            await page.evaluate(
                (message) =>
                    (globalThis as FixtureScope).fixture.terminal.onWebviewMessage(message),
                ready,
            );
            await page.waitForFunction(
                () => (globalThis as FixtureScope).fixture.subscriptions === 3,
            );
            await page.waitForFunction(
                () => (globalThis as FixtureScope).fixture.terminal.canControl,
            );
            expect(
                await page.evaluate(async () => {
                    const terminal = (globalThis as FixtureScope).fixture.terminal;
                    terminal.onWebviewMessage(
                        JSON.stringify({
                            version: 1,
                            terminalId: 'terminal-fixture',
                            type: 'error',
                            code: 'render-failed',
                        }),
                    );
                    return terminal.sendInput('fixture');
                }),
            ).toBe('blocked');
            await page.waitForFunction(
                () => (globalThis as FixtureScope).fixture.terminal.state === 'error',
            );
            expect(
                await page.evaluate(() => (globalThis as FixtureScope).fixture.terminal.canControl),
            ).toBe(false);
            await page.waitForFunction(
                () => (globalThis as FixtureScope).fixture.unsubscribed === 3,
            );
            const documentGeneration = await page.evaluate(() => {
                const terminal = (globalThis as FixtureScope).fixture.terminal;
                terminal.retry();
                return terminal.webviewGeneration;
            });
            await page.waitForFunction(
                (previous) =>
                    (globalThis as FixtureScope).fixture.terminal.webviewGeneration > previous,
                documentGeneration,
            );
            expect(
                await page.evaluate(() => (globalThis as FixtureScope).fixture.subscriptions),
            ).toBe(3);
            await page.evaluate(
                (message) =>
                    (globalThis as FixtureScope).fixture.terminal.onWebviewMessage(message),
                ready,
            );
            await page.waitForFunction(
                () =>
                    (globalThis as FixtureScope).fixture.subscriptions === 4 &&
                    (globalThis as FixtureScope).fixture.terminal.canControl,
            );
        } finally {
            await browser.close();
        }
    });

    it('replaces unparsed old output when a same-sized or resized snapshot arrives', async () => {
        const code = await browserBundle(`
            import { Terminal } from '@xterm/xterm';
            import { resetTerminalSnapshot } from '${root}/src/features/terminal/snapshot-reset.ts';
            globalThis.fixture = { run: async () => {
                const lines = [];
                for (const cols of [80, 60]) {
                    const terminal = new Terminal({ cols: 80, rows: 24 });
                    terminal.open(document.getElementById('root'));
                    terminal.write('OLD');
                    resetTerminalSnapshot(terminal, cols, 24);
                    await new Promise(resolve => terminal.write('NEW', resolve));
                    lines.push(terminal.buffer.active.getLine(0).translateToString(true));
                    terminal.dispose();
                }
                return lines;
            }};
        `);
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.setContent('<div id="root"></div>');
            await page.addScriptTag({ content: code });
            const result = await page.evaluate(() => (globalThis as FixtureScope).fixture.run());
            expect(errors).toEqual([]);
            expect(result).toEqual(['NEW', 'NEW']);
        } finally {
            await browser.close();
        }
    });

    it('keeps authenticated Terminal observations out of the shared React render stream', async () => {
        const code = await browserBundle(
            `
            import { createElement } from 'react';
            import { createRoot } from 'react-dom/client';
            import { useMobileClientController } from '${root}/src/features/connection/use-mobile-client-controller.ts';
            globalThis.fixture = { renders: 0, observation: null, termination: null };
            function Harness() {
                globalThis.fixture.renders++;
                globalThis.fixture.client = useMobileClientController();
                return null;
            }
            createRoot(document.getElementById('root')).render(createElement(Harness));
        `,
            {
                'react-native': `export const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };`,
                'expo-device': `export const modelName = 'Fixture phone';`,
                'expo-network': `export const addNetworkStateListener = () => ({ remove() {} });`,
                './expo-credential-store': `export const expoMobileCredentialStore = { load: async () => null, clear: async () => {} };`,
                './expo-mobile-gateway-runtime': `export const expoMobileGatewayRuntime = {};`,
                './mobile-gateway-client': `
                export class MobileGatewayRequestError extends Error {}
                export class MobileGatewayTimeoutError extends Error {}
                export class MobileReconnectError extends Error {}
                export class MobileVersionMismatchError extends Error {}
                export const reconnectMobileGateway = async () => { throw new Error('Unexpected reconnect'); };
                export const pairMobileGateway = async () => ({
                    credential: { serverId: 'server-fixture', deviceId: 'device-fixture', generation: 1 },
                    connection: {
                        close() {}, setForeground() {}, hasOutstandingMutation: () => false,
                        onObservation(listener) { globalThis.fixture.observation = listener; return () => {}; },
                        onTermination(listener) { globalThis.fixture.termination = listener; return () => {}; }
                    }
                });
            `,
            },
        );
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.setContent('<div id="root"></div>');
            await page.addScriptTag({ content: code });
            await page.waitForFunction(
                () =>
                    Reflect.has((globalThis as FixtureScope).fixture, 'client') &&
                    (globalThis as FixtureScope).fixture.client.status === 'unpaired',
                undefined,
                { timeout: 3_000 },
            );
            await page.evaluate(() =>
                (globalThis as FixtureScope).fixture.client.pair('fixture-link'),
            );
            await page.waitForFunction(
                () => (globalThis as FixtureScope).fixture.client.status === 'connected',
            );
            const result = await page.evaluate(async () => {
                const fixture = (globalThis as FixtureScope).fixture;
                if (typeof fixture.observation !== 'function')
                    throw new Error('Observation was not registered');
                const before = fixture.renders;
                const client = fixture.client;
                for (let index = 0; index < 12; index++) {
                    fixture.observation();
                    // eslint-disable-next-line no-await-in-loop -- Separate browser frames expose every avoidable React update.
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                }
                return {
                    renders: fixture.renders - before,
                    sameContext: client === fixture.client,
                    observed:
                        typeof fixture.client.getLastSeenAt === 'function' &&
                        fixture.client.getLastSeenAt() !== null,
                };
            });
            expect(result).toEqual({ renders: 0, sameContext: true, observed: true });
            expect(errors).toEqual([]);
        } finally {
            await browser.close();
        }
    });
});
