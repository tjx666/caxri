import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProviderPasteSummaryGenerationContext } from '../../contract';
import { canonicalPath } from '../../contract';
import { lowCostSandboxProfile, MACOS_SANDBOX_EXECUTABLE } from '../../low-cost-sandbox';
import { agentCommandEnvironment, assertAgentRenameVersion } from '../../rename';
import { runAgentTextCommand } from '../../text-generation';
import { resolveClaudeConfigDirectory } from './paths';

const CLAUDE_LOW_COST_GENERATION_MINIMUM_VERSION = '2.1.232';

/**
 * `--setting-sources ''` drops every `settings.json` layer, but Claude Code resolves its user memory from the
 * configuration directory rather than from the working directory, and exposes no switch that turns it off. An isolated
 * cwd therefore cannot reach it. The macOS host sandbox denies those two files by exact path, and re-denies the Project
 * root as defence in depth so a later flag regression cannot quietly widen a bounded text transformation.
 */
function sandboxProfile(projectDirectory: string, configDirectory: string): string {
    return lowCostSandboxProfile({
        literals: [join(configDirectory, 'CLAUDE.md'), join(configDirectory, 'CLAUDE.local.md')],
        subpaths: [projectDirectory],
    });
}

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
        const [canonicalProjectDirectory, canonicalConfigDirectory] = await Promise.all([
            canonicalPath(context.cwd),
            canonicalPath(resolveClaudeConfigDirectory(context.environment)),
        ]);
        return await runAgentTextCommand({
            arguments: [
                '-p',
                sandboxProfile(canonicalProjectDirectory, canonicalConfigDirectory),
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
            environment: agentCommandEnvironment(context.environment),
            executable: MACOS_SANDBOX_EXECUTABLE,
            input: context.prompt,
            limits: timeoutMs === undefined ? undefined : { timeoutMs },
            operation,
            signal: context.signal,
        });
    } finally {
        await rm(isolatedDirectory, { recursive: true, force: true });
    }
}
