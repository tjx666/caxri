import { join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';

import {
    fakeClaudeChatExecutableSource,
    fakeCodexChatExecutableSource,
} from '../../../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-chat-executables';

/**
 * Provider sources for the `agent-chat-v1` fixture. It reuses the deterministic Agent Chat fakes that Server tests and
 * Electron E2E drive (Claude Code stream-json and the Codex app-server JSON-RPC), so opening an Agent as Chat produces
 * real transcript rows (reply, command and file-change approvals, diffs) without a host CLI. Codex threads persist
 * beneath the fixture root, which the owned-profile cleanup removes.
 */
export function chatFixtureSource(provider: AgentProvider, fixtureRoot: string): string {
    if (provider === 'claude') return fakeClaudeChatExecutableSource();
    if (provider === 'codex') {
        return fakeCodexChatExecutableSource({
            stateDirectory: join(fixtureRoot, 'codex-threads'),
        });
    }
    throw new Error(`The agent-chat-v1 fixture has no ${provider} target`);
}
