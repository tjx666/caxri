import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AppSettings, BootstrapState } from '@caxri/protocol';
import type { Page } from '@playwright/test';

import { prepareAcceptanceAgentFixture } from '../../.agents/skills/acceptance/scripts/agent-fixtures';
import { pageRequest } from './helpers';
import { waitForMobile } from './mobile-android';

export type AttentionCommand =
    | 'fixture:background'
    | 'fixture:exit'
    | 'fixture:permission'
    | 'fixture:question'
    | 'fixture:start';
export interface AttentionReceipt {
    /**
     * The launch's Agent Session id on a `fixtureReady` receipt; Caxri binds it to the Terminal as `agentSessionId`.
     */
    agentSessionId?: string;
    attentionKind?: string;
    applied?: boolean;
    exists?: boolean;
    kind: string;
    pathValid?: boolean;
}

export async function prepareMobileAttentionAgent(userDataDirectory: string) {
    const fixture = await prepareAcceptanceAgentFixture({
        fixtureId: 'agent-features-v1',
        isPublicFrame: true,
        userDataDir: userDataDirectory,
    });
    return {
        agentMode: {
            mode: 'fake' as const,
            environment: fixture.environment,
            executables: fixture.executables,
        },
        receiptPath: join(fixture.environment.CLAUDE_CONFIG_DIR!, 'acceptance-receipts.jsonl'),
    };
}

export async function enableMobileAttentionHooks(page: Page): Promise<void> {
    const current = await pageRequest<{ value: AppSettings }>(page, 'settings.get');
    const settings = structuredClone(current.value);
    settings['agents.providers'].claude.hooks.enabled = true;
    await pageRequest(page, 'settings.update', {
        source: JSON.stringify(settings, null, 2),
    });
}

async function readAttentionReceipts(receiptPath: string): Promise<AttentionReceipt[]> {
    try {
        return (await readFile(receiptPath, 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as AttentionReceipt);
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return [];
        throw error;
    }
}

/**
 * Sends one fixture command after the Terminal's current fixture Agent launch published its `fixtureReady` receipt,
 * which it writes once it reads input and its initial turn has stopped. An earlier command could be lost or overwritten
 * by that initial Stop, so callers must not resend.
 */
export async function sendFixtureCommandWhenReady(
    page: Page,
    receiptPath: string,
    terminalId: string,
    command: AttentionCommand,
): Promise<void> {
    try {
        await waitForMobile(async () => {
            const state = await pageRequest<BootstrapState>(page, 'app.bootstrap');
            const agentSessionId = state.terminals.find(
                ({ id }) => id === terminalId,
            )?.agentSessionId;
            if (!agentSessionId) return false;
            return (await readAttentionReceipts(receiptPath)).some(
                (receipt) =>
                    receipt.kind === 'fixtureReady' && receipt.agentSessionId === agentSessionId,
            );
        }, Boolean);
    } catch (error) {
        // Only the bounded wait's timeout gets the readable cause; Host and filesystem errors propagate unchanged.
        if (error instanceof Error && error.message === 'Mobile Acceptance timed out')
            throw new Error(`The fixture Agent never became ready for ${command}`, {
                cause: error,
            });
        throw error;
    }
    await pageRequest(page, 'terminal.input', { terminalId, data: `${command}\r` });
}

export function mobileAttentionControl(page: Page, terminalId: string, receiptPath: string) {
    return {
        readReceipt: () => readAttentionReceipts(receiptPath),
        /**
         * Sends a fixture command to another fixture Agent Terminal, such as an extra Session in the paired Project.
         */
        sendTo: (otherTerminalId: string, command: AttentionCommand) =>
            sendFixtureCommandWhenReady(page, receiptPath, otherTerminalId, command),
        trigger: (command: AttentionCommand) =>
            sendFixtureCommandWhenReady(page, receiptPath, terminalId, command),
    };
}
