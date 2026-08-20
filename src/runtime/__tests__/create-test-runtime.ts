import type { IPty } from 'node-pty';
import { vi } from 'vitest';

import type { AgentAdapter } from '../agents/service';

/**
 * Creates the inert PTY used by Runtime composition tests that must not launch a login shell. Tests that need to emit
 * PTY data or exit events should keep a richer domain-local fake.
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
 * Prevents background Agent metadata probes from escaping hermetic Runtime composition tests.
 */
export function createPendingAgentAdapters(): Record<'claude' | 'codex', AgentAdapter> {
    const pending = new Promise<never>(() => {});
    return {
        claude: { provider: 'claude', snapshot: () => pending },
        codex: { provider: 'codex', snapshot: () => pending },
    };
}
