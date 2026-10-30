import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';

export type MobileChatCaseHandler = (
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
) => Promise<void>;

const CASES_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'mobile-chat-cases');

/**
 * Lists the handler modules a Chat case may live in: every `mobile-chat-cases/<group>.ts` except tests.
 */
export function mobileChatCaseGroups(directory = CASES_DIRECTORY): string[] {
    return readdirSync(directory)
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
        .map((file) => file.slice(0, -'.ts'.length))
        .toSorted((a, b) => a.localeCompare(b));
}

/**
 * Collects the handlers every `mobile-chat-cases/<group>.ts` module exports as `handlers`, keyed by case id. A
 * duplicate id fails loudly, so two parallel sessions cannot silently shadow each other's case.
 */
export async function collectMobileChatCaseHandlers(
    directory = CASES_DIRECTORY,
): Promise<Map<string, MobileChatCaseHandler>> {
    const collected = new Map<string, MobileChatCaseHandler>();
    const groups = mobileChatCaseGroups(directory);
    const modules = await Promise.all(
        groups.map(
            (group) =>
                import(pathToFileURL(join(directory, `${group}.ts`)).href) as Promise<{
                    handlers?: Record<string, MobileChatCaseHandler>;
                }>,
        ),
    );
    for (const [index, module] of modules.entries()) {
        if (!module.handlers) {
            throw new Error(`mobile-chat-cases/${groups[index]}.ts must export handlers`);
        }
        for (const [caseId, handler] of Object.entries(module.handlers)) {
            if (collected.has(caseId))
                throw new Error(`Duplicate Agent Chat case handler: ${caseId}`);
            collected.set(caseId, handler);
        }
    }
    return collected;
}

/**
 * Runs the Agent Chat Acceptance case `environment.caseId` through the handler its own group module registered.
 */
export async function executeMobileAgentChatCase(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const handler = (await collectMobileChatCaseHandlers()).get(environment.caseId);
    if (!handler) {
        throw new Error(`Unsupported Agent Chat Acceptance case: ${environment.caseId}`);
    }
    return handler(environment, artifacts);
}
