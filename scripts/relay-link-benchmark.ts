#!/usr/bin/env bun

/**
 * Measures how long a phone takes to reconnect through the Relay and open a Session, on simulated links. See
 * `docs/mobile/performance.md`.
 *
 *     bun run benchmark:relay-link                              # every profile, 5 rounds each
 *     bun run benchmark:relay-link --profiles sg-proxy --rounds 10
 *
 * One process runs the real pieces: the Relay (`apps/relay/src/main.ts`, spawned), a `MobileGateway` with canned
 * command replies, and the phone's own connection code from `apps/mobile`. Two shaped TCP proxies sit in front of the
 * Relay, one for the phone's leg and one for the computer's, each adding its round trip and its connection setup (TCP
 * plus TLS). The phone's stored LAN address points at a listener that accepts and never answers, the way a home address
 * behaves on cellular, so every reconnect pays the real direct-route grace before the Relay joins.
 *
 * The receipt (`test-results/receipts/relay-link.json` by default) holds every round, the per-profile median and worst,
 * each metric in units of E (one phone-to-computer round trip through the Relay), and the Server and Relay log events
 * the rounds produced.
 *
 * The phone modules it imports are listed one by one in `tsconfig.node.json`, so they typecheck here without pulling in
 * Expo's global types; a new import from `apps/mobile` must be added to that list.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo, Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import type { Principal } from '@caxri/protocol';
import { CaxriError, emptyAgentChatSnapshot } from '@caxri/protocol';

import { startAgentChatReader } from '../apps/mobile/src/features/agent-chat/agent-chat-sync';
import type {
    MobileCredential,
    MobileCredentialStore,
} from '../apps/mobile/src/features/connection/credential-store';
import type {
    MobileGatewayConnection,
    MobileGatewayRuntime,
} from '../apps/mobile/src/features/connection/mobile-gateway-client';
import {
    pairMobileGateway,
    reconnectMobileGateway,
} from '../apps/mobile/src/features/connection/mobile-gateway-client';
import { createMobileRouteHints } from '../apps/mobile/src/features/connection/route-hints';
import { startDashboardSubscription } from '../apps/mobile/src/features/sessions/dashboard-query';
import { createMemoryMobileDeviceStore } from '../apps/server/src/core/__tests__/credential-stores.fixture';
import { MobileDeviceRegistry } from '../apps/server/src/core/mobile/device-registry';
import { MobileGateway } from '../apps/server/src/core/mobile/gateway';
import { isMobileGatewayMethodAllowedForRole } from '../apps/server/src/core/mobile/role-methods';
import type { ShapedLink, ShapedProxy } from './link-shaping';
import { startShapedProxy } from './link-shaping';

const repoRoot = resolvePath(import.meta.dirname, '..');
const relayMain = resolvePath(repoRoot, 'apps/relay/src/main.ts');
const SESSION_ID = 'session-1';
const TERMINAL_ID = 'terminal-1';

interface RelayLinkProfile {
    /**
     * The computer's leg: Server to Relay.
     */
    host: ShapedLink;
    /**
     * The phone's leg: phone to Relay.
     */
    phone: ShapedLink;
}

/**
 * Round trips measured on 2026-10-30 against the Relay in Railway's Singapore region. `sg-proxy` is a computer and a
 * phone that both reach it through a Singapore proxy node (60 ms from the computer; the phone's cellular hop is assumed
 * to add 30 ms). `cn-direct` is a phone reaching it without a proxy from mainland China, whose traffic entered
 * Railway's edge in Paris (230 ms). Both legs pay TCP plus TLS before their first byte, as `wss://` does.
 */
const PROFILES: Record<string, RelayLinkProfile> = {
    'local': { phone: { rttMs: 0 }, host: { rttMs: 0 } },
    'sg-proxy': {
        phone: { rttMs: 90, setupRoundTrips: 2 },
        host: { rttMs: 60, setupRoundTrips: 2 },
    },
    'cn-direct': {
        phone: { rttMs: 230, setupRoundTrips: 2 },
        host: { rttMs: 60, setupRoundTrips: 2 },
    },
};

interface RoundResult {
    /**
     * Reconnect call until the encrypted session is ready.
     */
    readyMs: number;
    /**
     * Reconnect call until the first Session list snapshot arrived.
     */
    firstDashboardMs: number;
    /**
     * Opening a Session (its changes and Chat subscriptions start together) until the Chat's first snapshot.
     */
    sessionOpenMs: number;
}

type Metric = keyof RoundResult;
const METRICS: Metric[] = ['readyMs', 'firstDashboardMs', 'sessionOpenMs'];

interface LoggedEvent {
    event: string;
    fields?: unknown;
    source: 'relay' | 'server';
}

async function startRelay(events: LoggedEvent[]): Promise<{ child: ChildProcess; port: number }> {
    const child = spawn('bun', [relayMain], {
        env: { ...process.env, CAXRI_RELAY_HOST: '127.0.0.1', CAXRI_RELAY_PORT: '0' },
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: child.stdout });
    const { promise: port, resolve: resolvePort } = Promise.withResolvers<number>();
    lines.on('line', (line) => {
        const parsed = JSON.parse(line) as { event?: string; port?: number };
        if (parsed.event === 'relay.listening' && parsed.port) resolvePort(parsed.port);
        else if (parsed.event)
            events.push({ source: 'relay', event: parsed.event, fields: parsed });
    });
    return { child, port: await port };
}

/**
 * Accepts TCP and never answers the WebSocket upgrade: a LAN address seen from cellular, where the SYN is dropped.
 */
async function startBlackhole(): Promise<{ port: number; server: Server; sockets: Set<Socket> }> {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, server, sockets };
}

function authorizeMethod(principal: Principal, method: string): void {
    if (
        principal.kind !== 'paired-device' ||
        !isMobileGatewayMethodAllowedForRole(principal.role, method)
    )
        throw new CaxriError('FORBIDDEN', 'Paired device role does not allow this method');
}

const session = {
    id: SESSION_ID,
    projectId: 'project-1',
    title: 'Benchmark Session',
    projectTitle: 'Example',
    lastVisitedAt: 1,
    sessionActivityAt: 1,
    agentActivityState: 'idle',
    attentionGeneration: 0,
    hasUnread: false,
    primaryTerminal: {
        id: TERMINAL_ID,
        sessionId: SESSION_ID,
        kind: 'codex',
        lastProcessState: 'running',
        surface: 'chat',
    },
};

const cannedResult = (method: string): unknown => {
    switch (method) {
        case 'mobile.dashboard': {
            return {
                hostDisplayName: 'Benchmark computer',
                deviceRole: 'control',
                projects: [{ id: 'project-1', title: 'Example' }],
                sessions: [session],
                total: 1,
                truncated: false,
            };
        }
        case 'mobile.session.show': {
            return { session };
        }
        case 'mobile.agentChat.read': {
            return emptyAgentChatSnapshot(TERMINAL_ID);
        }
        default: {
            throw new CaxriError('NOT_FOUND', `The benchmark does not serve ${method}`);
        }
    }
};

/**
 * A phone runtime with its own route memory, so each profile starts the way a freshly installed phone does.
 */
const createRuntime = (): MobileGatewayRuntime => {
    const stored = new Map<string, string>();
    return {
        openWebSocket: (url) => new WebSocket(url),
        platform: 'android',
        randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
        routeHints: createMobileRouteHints({
            getItemAsync: (key) => Promise.resolve(stored.get(key) ?? null),
            setItemAsync: (key, value) => {
                stored.set(key, value);
                return Promise.resolve();
            },
        }),
    };
};

/**
 * Holds the paired credential in memory; the phone's secure store is not part of what this measures.
 */
const memoryStore = (): MobileCredentialStore & { current: MobileCredential | null } => {
    const store = {
        current: null as MobileCredential | null,
        clear: () => {
            store.current = null;
            return Promise.resolve();
        },
        clearIfCurrent: () => Promise.resolve(false),
        load: () => Promise.resolve(store.current),
        save: (credential: MobileCredential) => {
            store.current = credential;
            return Promise.resolve();
        },
    };
    return store;
};

const until = async (isDone: () => boolean, timeoutMs: number, what: string): Promise<void> => {
    const deadline = performance.now() + timeoutMs;
    while (!isDone()) {
        if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        // eslint-disable-next-line no-await-in-loop -- polling a condition owned by another component.
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

/**
 * The Session list screen's order (`use-session-polling.ts`): subscribe to the dashboard, and read it as soon as the
 * subscription mode leaves `pending`.
 */
const firstDashboard = (connection: MobileGatewayConnection): Promise<unknown> => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    let didRead = false;
    startDashboardSubscription(
        (onEvent) => connection.subscribe({ kind: 'dashboard' }, onEvent),
        () => {},
        (mode) => {
            if (mode === 'pending' || didRead) return;
            didRead = true;
            resolve(connection.request('mobile.dashboard'));
        },
        () => {},
    );
    return promise;
};

/**
 * A Session opened from the list already knows its Chat Terminal, so its changes subscription (`use-changes.ts`) and
 * its Chat reader (`use-agent-chat.ts`) start in the same render.
 */
const openSession = (connection: MobileGatewayConnection): Promise<void> =>
    new Promise((resolve, reject) => {
        void connection.subscribe({ kind: 'changes', sessionId: SESSION_ID }, () => {});
        startAgentChatReader({
            read: () => connection.request('mobile.agentChat.read', { terminalId: TERMINAL_ID }),
            subscribe: (listener) =>
                connection.subscribe({ kind: 'agentChat', terminalId: TERMINAL_ID }, listener),
            onRetry: () => {},
            onSnapshot: () => resolve(),
            onError: () => reject(new Error('The Chat read failed')),
        });
    });

async function measureRound(
    credential: MobileCredential,
    store: MobileCredentialStore,
    runtime: MobileGatewayRuntime,
): Promise<RoundResult> {
    const startedAt = performance.now();
    const connection = await reconnectMobileGateway(credential, runtime, store);
    const readyMs = performance.now() - startedAt;
    try {
        await firstDashboard(connection);
        const firstDashboardMs = performance.now() - startedAt;
        const openedAt = performance.now();
        await openSession(connection);
        return { readyMs, firstDashboardMs, sessionOpenMs: performance.now() - openedAt };
    } finally {
        connection.close('superseded');
    }
}

const median = (values: number[]): number => {
    const sorted = values.toSorted((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

async function measureProfile(
    name: string,
    profile: RelayLinkProfile,
    context: {
        blackholePort: number;
        credential: MobileCredential;
        gateway: MobileGateway;
        relayPort: number;
        rounds: number;
        store: MobileCredentialStore;
    },
) {
    const target = { host: '127.0.0.1', port: context.relayPort };
    const proxies: ShapedProxy[] = [];
    try {
        const phoneLeg = await startShapedProxy(target, profile.phone);
        proxies.push(phoneLeg);
        const hostLeg = await startShapedProxy(target, profile.host);
        proxies.push(hostLeg);
        await context.gateway.configureRelay(`ws://127.0.0.1:${hostLeg.port}`);
        await until(
            () => context.gateway.status().relay?.state === 'online',
            10_000,
            'the Relay to come online',
        );
        const credential: MobileCredential = {
            ...context.credential,
            addresses: ['127.0.0.1'],
            port: context.blackholePort,
            relay: {
                url: `ws://127.0.0.1:${phoneLeg.port}`,
                hostId: context.gateway.status().relay!.hostId,
            },
        };
        const runtime = createRuntime();
        const rounds: RoundResult[] = [];
        for (let round = 0; round < context.rounds; round += 1) {
            // eslint-disable-next-line no-await-in-loop -- rounds are sequential so they never share a link.
            rounds.push(await measureRound(credential, context.store, runtime));
            // eslint-disable-next-line no-await-in-loop -- lets the Server and Relay finish the closed connection.
            await new Promise((resolve) => setTimeout(resolve, 200 + profile.phone.rttMs));
        }
        const roundTripMs = profile.phone.rttMs + profile.host.rttMs;
        // The first round has no route memory yet; the rest reconnect the way a phone that used the Relay before does.
        const warm = rounds.length > 1 ? rounds.slice(1) : rounds;
        const coldReadyMs = Math.round(rounds[0]?.readyMs ?? 0);
        const summary = Object.fromEntries(
            METRICS.map((metric) => {
                const values = warm.map((round) => round[metric]);
                const medianMs = median(values);
                return [
                    metric,
                    {
                        medianMs: Math.round(medianMs),
                        worstMs: Math.round(Math.max(...values)),
                        medianE:
                            roundTripMs > 0 ? Number((medianMs / roundTripMs).toFixed(2)) : null,
                    },
                ];
            }),
        );
        return { name, profile, roundTripMs, rounds, coldReadyMs, summary };
    } finally {
        await context.gateway.configureRelay(null);
        await Promise.all(proxies.map((proxy) => proxy.close()));
    }
}

const formatTable = (results: Array<Awaited<ReturnType<typeof measureProfile>>>): string => {
    const rows = [
        [
            'profile',
            'E (ms)',
            'cold readyMs',
            ...METRICS.map((metric) => `${metric} median / worst (E)`),
        ],
        ...results.map((result) => [
            result.name,
            String(result.roundTripMs),
            String(result.coldReadyMs),
            ...METRICS.map((metric) => {
                const item = result.summary[metric];
                return `${item.medianMs} / ${item.worstMs} (${item.medianE ?? '-'})`;
            }),
        ]),
    ];
    const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
    return rows
        .map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join('  '))
        .join('\n');
};

if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            profiles: { type: 'string', default: Object.keys(PROFILES).join(',') },
            rounds: { type: 'string', default: '5' },
            receipt: { type: 'string', default: 'test-results/receipts/relay-link.json' },
        },
    });
    const names = values.profiles.split(',').filter(Boolean);
    for (const name of names)
        if (!Object.hasOwn(PROFILES, name))
            throw new Error(`Unknown profile ${name}; use ${Object.keys(PROFILES).join(', ')}`);
    const events: LoggedEvent[] = [];
    const relay = await startRelay(events);
    const blackhole = await startBlackhole();
    const gateway = new MobileGateway({
        adapters: { server: { invoke: (request) => cannedResult(request.method) } },
        authorizePairedDeviceMethod: authorizeMethod,
        authorizeSubscription: () => Promise.resolve(),
        matchesSubscriptionEvent: () => Promise.resolve(true),
        bootId: 'b'.repeat(32),
        protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
        registry: MobileDeviceRegistry.open({ store: createMemoryMobileDeviceStore() }),
        logger: {
            write: (_level, event, options) =>
                events.push({ source: 'server', event, fields: options?.fields }),
        },
        selectAddress: () => '127.0.0.1',
        relayTiming: { initialBackoffMs: 50, maxBackoffMs: 200 },
    });
    try {
        await gateway.enable();
        const store = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Benchmark phone',
            pairingLink: gateway.createPairing(['project-1']).pairingLink,
            runtime: createRuntime(),
            store,
        });
        paired.connection.close('superseded');
        const results: Array<Awaited<ReturnType<typeof measureProfile>>> = [];
        for (const name of names) {
            // eslint-disable-next-line no-await-in-loop -- profiles run one after another so they never share a link.
            const result = await measureProfile(name, PROFILES[name], {
                blackholePort: blackhole.port,
                credential: paired.credential,
                gateway,
                relayPort: relay.port,
                rounds: Number(values.rounds),
                store,
            });
            results.push(result);
        }
        const receiptFile = resolvePath(repoRoot, values.receipt);
        await mkdir(resolvePath(receiptFile, '..'), { recursive: true });
        await writeFile(receiptFile, JSON.stringify({ results, events }, null, 2));
        console.log(`\n${formatTable(results)}\n\nReceipt: ${receiptFile}`);
    } finally {
        await gateway.close();
        for (const socket of blackhole.sockets) socket.destroy();
        blackhole.server.close();
        relay.child.kill('SIGTERM');
        await once(relay.child, 'exit');
    }
}
