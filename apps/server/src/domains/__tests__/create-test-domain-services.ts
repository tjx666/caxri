import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';
import type { IPty } from 'node-pty';
import { vi } from 'vitest';

import { claudeTranscriptPath } from '../agents/providers/claude/paths';
import type { AgentAdapter } from '../agents/service';
import { AgentService } from '../agents/service';

type TestAgentAdapterOverride = Pick<AgentAdapter, 'provider'> &
    Partial<Omit<AgentAdapter, 'provider'>>;

/**
 * Creates the inert PTY used by domain-service tests that must not launch a login shell. Tests that need to emit PTY
 * data or exit events should keep a richer domain-local fake.
 */
export function createFakePty(): IPty {
    return {
        pid: 4242,
        kill: vi.fn(),
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        onExit: vi.fn(() => ({ dispose: vi.fn() })),
        resize: vi.fn(),
        write: vi.fn(),
    } as unknown as IPty;
}

/**
 * Prevents background Agent metadata probes from escaping hermetic domain-service tests.
 */
export function createPendingAgentAdapters(
    overrides: Partial<Record<AgentProvider, TestAgentAdapterOverride>> = {},
): Record<AgentProvider, AgentAdapter> {
    const pending = new Promise<never>(() => {});
    return Object.fromEntries(
        agentProviderIds.map((provider) => [
            provider,
            {
                provider,
                renameSession: () => pending,
                snapshot: () => pending,
                ...overrides[provider],
            },
        ]),
    ) as Record<AgentProvider, AgentAdapter>;
}

/**
 * Keeps focused Agent tests exhaustive for the catalog without making every fixture restate inert providers.
 */
export function createTestAgentService(
    overrides: Partial<Record<AgentProvider, TestAgentAdapterOverride>> = {},
    logger?: ConstructorParameters<typeof AgentService>[0],
): AgentService {
    return new AgentService(logger, createPendingAgentAdapters(overrides));
}

/**
 * Claude Code writes a conversation's transcript only with its first prompt, and restore or restart resumes only a
 * written conversation. Tests that expect `--resume` seed this placeholder under an isolated `homeDirectory`.
 */
export async function writeClaudeTranscript(
    homeDirectory: string,
    cwd: string,
    agentSessionId: string,
): Promise<void> {
    const path = claudeTranscriptPath(join(homeDirectory, '.claude'), cwd, agentSessionId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{}\n');
}
