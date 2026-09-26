import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings } from '@caxri/protocol';
import type { Page } from '@playwright/test';

import { prepareAcceptanceAgentFixture } from '../../.agents/skills/acceptance/scripts/agent-fixtures';
import { pageRequest } from './helpers';

export type AttentionCommand = 'fixture:permission' | 'fixture:question' | 'fixture:exit';
export interface AttentionReceipt {
    attentionKind?: string;
    applied?: boolean;
    kind: string;
}

export async function prepareMobileAttentionAgent(userDataDirectory: string) {
    const fixture = await prepareAcceptanceAgentFixture({
        fixtureId: 'agent-features-v1',
        userDataDir: userDataDirectory,
        sourceEnvironment: { ...process.env, CAXRI_ACCEPTANCE_PUBLIC_FRAME: '1' },
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

export function mobileAttentionControl(page: Page, terminalId: string, receiptPath: string) {
    return {
        readReceipt: async (): Promise<AttentionReceipt[]> => {
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
        },
        trigger: async (command: AttentionCommand): Promise<void> => {
            await pageRequest(page, 'terminal.input', {
                terminalId,
                data: `${command}\r`,
            });
        },
    };
}
