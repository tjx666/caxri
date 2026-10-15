import type { AgentChatTrackerArtifact } from '@caxri/protocol';
import {
    gitChangesDiffTabPath,
    gitCommitFileDiffTabPath,
    gitFileDiffTabPath,
    gitPullRequestChangesDiffTabPath,
    gitPullRequestFileDiffTabPath,
} from '@caxri/protocol';

/**
 * Inputs for `english-counterpart-parity.test.ts`: chosen so both sides of every registered pair reach each branch.
 */

/**
 * Every provider tool name in the protocol tool table, plus shell commands that read, search, or list, and the Computer
 * Use and MCP shapes, so every English label the table can produce is looked up.
 */
export const TOOL_CALLS: Array<{ name: string; summary?: string }> = [
    ...[
        'bash',
        'shell',
        'exec_command',
        'local_shell',
        'BashOutput',
        'write_stdin',
        'KillShell',
        'KillBash',
        'Read',
        'NotebookRead',
        'LS',
        'Edit',
        'MultiEdit',
        'NotebookEdit',
        'apply_patch',
        'Write',
        'Grep',
        'Glob',
        'ToolSearch',
        'WebFetch',
        'WebSearch',
        'web_search',
        'Task',
        'Agent',
        'spawnAgent',
        'sendInput',
        'sendMessage',
        'closeAgent',
        'interruptAgent',
        'wait',
        'wait_agent',
        'agentCompleted',
        'TodoWrite',
        'update_plan',
        'ExitPlanMode',
        'Skill',
        'AskUserQuestion',
        'view_image',
        'reasoning',
    ].map((name) => ({ name, summary: 'subject' })),
    { name: 'shell', summary: 'cat src/app.ts' },
    { name: 'shell', summary: 'rg TODO src' },
    { name: 'shell', summary: 'ls src' },
    { name: 'shell', summary: 'ls' },
    { name: 'browserUse' },
    { name: 'computerUse' },
    { name: 'computerUse', summary: 'Clicked Save' },
    { name: 'mcp__github__create_issue' },
    { name: 'github/create_issue' },
    { name: 'MysteryTool' },
];

export const TRACKERS: AgentChatTrackerArtifact[] = [undefined, 1, 2].flatMap((round) =>
    [undefined, 0, 1, 2].map((checks): AgentChatTrackerArtifact => ({
        provider: 'lobehub',
        kind: 'acceptance',
        action: 'created',
        url: 'https://example.com/acceptance/abcdef12',
        reference: 'abcdef12',
        excerpt: 'First line',
        ...(round !== undefined && { round }),
        ...(checks !== undefined && { checks }),
    })),
);

export const DIFF_TAB_PATHS = [
    gitFileDiffTabPath('repo-1', 'src/deep/app.ts'),
    gitPullRequestFileDiffTabPath('repo-1', 'src/app.ts'),
    gitChangesDiffTabPath('repo-1', 'caxri'),
    gitChangesDiffTabPath('repo-1', 'caxri', true),
    gitPullRequestChangesDiffTabPath('repo-1', 'caxri'),
    gitCommitFileDiffTabPath('repo-1', 'a'.repeat(40), 'src/app.ts'),
];
