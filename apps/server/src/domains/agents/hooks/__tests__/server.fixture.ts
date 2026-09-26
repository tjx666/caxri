import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';
import type { Mock } from 'vitest';
import { expect, onTestFinished, vi } from 'vitest';

import type { AgentLifecycleSignal } from '../contract';
import type { AgentHookSignalResult } from '../server';
import { AgentHookServer } from '../server';

const SCHEMA_VERSIONS = Object.fromEntries(
    agentProviderIds.map((provider) => [provider, 2]),
) as Record<AgentProvider, number>;

/**
 * Every settled diagnostic carries a measured `handlingMs`. Diagnostics are asserted with exact `toHaveBeenCalledWith`
 * shapes so a newly leaked field fails the privacy contract, which leaves no room for `objectContaining`; this typed
 * matcher keeps that exactness without spreading an `any` through each expectation.
 */
export const anyHandlingMs = expect.any(Number) as number;

/**
 * The staged bridge exits 0 for a non-Grok provider when `GROK_SESSION_ID` is set, because Grok imports Claude hooks by
 * default. Manager tests that spawn that bridge must not inherit the host Agent's session identity.
 */
export function hookBridgeEnvironment(
    environment: NodeJS.ProcessEnv,
    overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
    const environment_ = { ...process.env, ...environment, ...overrides };
    delete environment_.GROK_SESSION_ID;
    return environment_;
}

export function validPayload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        protocolVersion: 1,
        schemaVersion: 2,
        launchId: 'launch-1',
        terminalId: 'terminal-1',
        provider: 'codex',
        phase: 'turnFinished',
        token: 'placeholder-token',
        ...overrides,
    });
}

/**
 * Connects to the hook socket, writes the raw wire payload, and collects whatever the server writes back before the
 * connection closes. An oversized payload makes the server destroy the socket without ever replying, so callers must
 * tolerate an empty response.
 */
export async function send(socketPath: string, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let response = '';
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.end(payload));
        socket.on('data', (chunk: string) => {
            response += chunk;
        });
        socket.on('close', () => resolve(response));
        socket.on('error', reject);
    });
}

type HookSignalHandler = (
    signal: AgentLifecycleSignal,
) => AgentHookSignalResult | Promise<AgentHookSignalResult>;

interface TestHookServer {
    onDiagnostic: Mock;
    onSignal: Mock<HookSignalHandler>;
    server: AgentHookServer;
    socketPath: string;
}

/**
 * Starts one hook server on an isolated socket. The handler is always wrapped in a fresh spy, so a caller that supplies
 * its own behavior still gets call assertions through the returned `onSignal`. The return type is written out because
 * this fixture crosses a module boundary and Vitest's inferred spy type is not portable.
 */
export async function createTestServer(
    handler: HookSignalHandler = () => ({ disposition: 'accepted' }),
    onAttention?: ConstructorParameters<typeof AgentHookServer>[4],
): Promise<TestHookServer> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-server-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const socketPath = join(directory, 'hooks.sock');
    const onSignal = vi.fn(handler);
    const onDiagnostic = vi.fn();
    const server = new AgentHookServer(
        socketPath,
        SCHEMA_VERSIONS,
        onSignal,
        onDiagnostic,
        onAttention,
    );
    await server.start();
    return { server, socketPath, onDiagnostic, onSignal };
}
