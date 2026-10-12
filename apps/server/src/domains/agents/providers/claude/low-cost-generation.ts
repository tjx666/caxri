import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProviderLowCostGenerationContext } from '../../contract';
import { prepareLowCostSandbox } from '../../low-cost-sandbox';
import { agentCommandEnvironment, assertAgentRenameVersion } from '../../rename';
import { runAgentTextCommand } from '../../text-generation';
import { resolveClaudeConfigDirectory } from './paths';

const CLAUDE_LOW_COST_GENERATION_MINIMUM_VERSION = '2.1.232';

/**
 * `--setting-sources ''` drops every `settings.json` layer, but Claude Code resolves its user memory from the
 * configuration directory rather than from the working directory, and exposes no switch that turns it off. An isolated
 * cwd therefore cannot reach it. The macOS host sandbox denies those two files by exact path, and re-denies the Project
 * root as defence in depth so a later flag regression cannot quietly widen a bounded text transformation. Safe mode
 * plus an isolated cwd prevents Project CLAUDE.md and provider customizations from changing a bounded text
 * transformation, while Claude Code can still use the provider account already authenticated in its configured home.
 */
export async function generateClaudeLowCostText(
    context: AgentProviderLowCostGenerationContext,
    systemInstructions: string,
    operation: string,
    timeoutMs?: number,
): Promise<string> {
    assertAgentRenameVersion('claude', context.version, CLAUDE_LOW_COST_GENERATION_MINIMUM_VERSION);
    const isolatedDirectory = await mkdtemp(join(tmpdir(), 'caxri-claude-text-'));
    try {
        const sandbox = await prepareLowCostSandbox({
            projectDirectory: context.cwd,
            configDirectory: resolveClaudeConfigDirectory(context.environment),
            executable: context.executable,
            isolatedDirectory,
            instructionNames: ['CLAUDE.md', 'CLAUDE.local.md'],
        });
        return await runAgentTextCommand({
            arguments: [
                ...sandbox.arguments,
                context.executable,
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
            environment: await agentCommandEnvironment(context.environment),
            executable: sandbox.executable,
            input: context.prompt,
            limits: timeoutMs === undefined ? undefined : { timeoutMs },
            operation,
            signal: context.signal,
        });
    } finally {
        await rm(isolatedDirectory, { recursive: true, force: true });
    }
}
