import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProviderLowCostGenerationContext } from '../../contract';
import { prepareLowCostSandbox } from '../../low-cost-sandbox';
import { agentCommandEnvironment, assertAgentRenameVersion } from '../../rename';
import { runAgentTextCommand } from '../../text-generation';
import { resolveCodexHome } from './paths';

const CODEX_LOW_COST_GENERATION_MINIMUM_VERSION = '0.122.0';
const CODEX_LOW_COST_MODEL = 'gpt-5.6-luna';

function parseCodexText(stdout: string): string {
    let text = '';
    for (const line of stdout.split('\n')) {
        try {
            const event = JSON.parse(line) as {
                item?: { text?: unknown; type?: unknown };
                type?: unknown;
            };
            if (
                event.type === 'item.completed' &&
                event.item?.type === 'agent_message' &&
                typeof event.item.text === 'string'
            ) {
                text = event.item.text.trim();
            }
        } catch {
            // Non-JSON diagnostics and unrelated stream events are ignored.
        }
    }
    return text;
}

/**
 * Codex has no CLI switch for its global AGENTS.md. The macOS host sandbox therefore denies both global instruction
 * files and the Project itself while leaving provider authentication and model network access intact.
 */
export async function generateCodexLowCostText(
    context: AgentProviderLowCostGenerationContext,
    systemInstructions: string,
    operation: string,
    timeoutMs?: number,
): Promise<string> {
    assertAgentRenameVersion('codex', context.version, CODEX_LOW_COST_GENERATION_MINIMUM_VERSION);
    const isolatedDirectory = await mkdtemp(join(tmpdir(), 'caxri-codex-text-'));
    try {
        const sandbox = await prepareLowCostSandbox({
            projectDirectory: context.cwd,
            configDirectory: resolveCodexHome(context.environment),
            executable: context.executable,
            isolatedDirectory,
            instructionNames: ['AGENTS.md', 'AGENTS.override.md'],
        });
        const output = await runAgentTextCommand({
            arguments: [
                ...sandbox.arguments,
                context.executable,
                'exec',
                '--ephemeral',
                '--ignore-user-config',
                '--ignore-rules',
                '--disable',
                'codex_hooks',
                '--disable',
                'shell_tool',
                '--disable',
                'multi_agent',
                '--disable',
                'apps',
                '--skip-git-repo-check',
                '-m',
                CODEX_LOW_COST_MODEL,
                '-c',
                'model_reasoning_effort="low"',
                '-c',
                'project_doc_max_bytes=0',
                '-c',
                'project_doc_fallback_filenames=[]',
                '-c',
                'web_search="disabled"',
                '-s',
                'read-only',
                '--json',
                '-',
            ],
            cwd: isolatedDirectory,
            environment: await agentCommandEnvironment(context.environment),
            executable: sandbox.executable,
            input: `${systemInstructions}\n\n${context.prompt}`,
            limits: timeoutMs === undefined ? undefined : { timeoutMs },
            operation,
            signal: context.signal,
        });
        return parseCodexText(output);
    } finally {
        await rm(isolatedDirectory, { recursive: true, force: true });
    }
}
