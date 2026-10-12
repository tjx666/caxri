import {
    agentProviderCatalog,
    agentProviderIds,
    defaultAgentProviderSettings,
    emptyAgentChatSnapshot,
} from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { agentChatDrivers } from '../chat-drivers';
import type { AgentChatSessionHost } from '../chat-provider';

/**
 * A host for a session that is constructed but never started: construction only reads settings, so no process spawns.
 */
function unstartedHost(provider: (typeof agentProviderIds)[number]): AgentChatSessionHost {
    const { launch } = defaultAgentProviderSettings[provider];
    return {
        terminalId: 'terminal',
        cwd: '/project',
        executable: launch.executable,
        environment: {},
        launch,
        isRealAgentE2E: false,
        permission: { planMode: false },
        clientVersion: '0.0.0',
        read: () => emptyAgentChatSnapshot('terminal'),
        apply: vi.fn(),
        applyTask: vi.fn(),
        readTask: () => {},
        lifecycle: vi.fn(),
        observeLifecycle: vi.fn(async () => {}),
        onSessionBound: vi.fn(),
        onTurnFinished: vi.fn(),
        onPermissionChanged: vi.fn(),
        onProtocolRejected: vi.fn(),
        onDeliveryChecked: vi.fn(),
        onForkReleaseFailed: vi.fn(),
        onExit: vi.fn(),
        readTranscript: () => Promise.resolve(undefined),
    };
}

describe('agentChatDrivers', () => {
    it.each(agentProviderIds)(
        'has a %s driver exactly when the catalog marks the provider Chat-capable',
        (provider) => {
            expect(Boolean(agentChatDrivers[provider])).toBe(
                agentProviderCatalog[provider].capabilities.chat,
            );
        },
    );

    it.each(agentProviderIds.filter((provider) => agentChatDrivers[provider]))(
        'gives a %s session restoreFiles exactly when the catalog offers chatRewindFiles',
        (provider) => {
            const session = agentChatDrivers[provider]!.create(unstartedHost(provider));
            expect(typeof session.restoreFiles === 'function').toBe(
                agentProviderCatalog[provider].capabilities.chatRewindFiles,
            );
        },
    );
});
