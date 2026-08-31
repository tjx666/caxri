import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProviderPasteSummaryGenerationContext } from '../../contract';
import { agentCommandEnvironment, assertAgentRenameVersion } from '../../rename';
import { runAgentTextCommand } from '../../text-generation';

const CLAUDE_LOW_COST_GENERATION_MINIMUM_VERSION = '2.1.232';

/**
 * Safe mode plus an isolated cwd prevents Project CLAUDE.md and provider customizations from changing a bounded text
 * transformation, while Claude Code can still use the provider account already authenticated in its configured home.
 */
export async function generateClaudeLowCostText(
    context: AgentProviderPasteSummaryGenerationContext,
    systemInstructions: string,
    operation: string,
    timeoutMs?: number,
): Promise<string> {
    assertAgentRenameVersion('claude', context.version, CLAUDE_LOW_COST_GENERATION_MINIMUM_VERSION);
    const isolatedDirectory = await mkdtemp(join(tmpdir(), 'caxri-claude-text-'));
    try {
        return await runAgentTextCommand({
            arguments: [
                '--print',
                '--model',
                'haiku',
                '--no-session-persistence',
                '--safe-mode',
                '--tools',
                '',
                '--mcp-config',
                '{"mcpServers":{}}',
                '--strict-mcp-config',
                '--setting-sources',
                '',
                '--no-chrome',
                '--disable-slash-commands',
                '--system-prompt',
                systemInstructions,
                '--effort',
                'low',
                '--max-turns',
                '1',
            ],
            cwd: isolatedDirectory,
            environment: agentCommandEnvironment(context.environment),
            executable: context.executable,
            input: context.prompt,
            limits: timeoutMs === undefined ? undefined : { timeoutMs },
            operation,
            signal: context.signal,
        });
    } finally {
        await rm(isolatedDirectory, { recursive: true, force: true });
    }
}
