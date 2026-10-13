import type {
    AgentChatFileChange,
    AgentChatItemStatus,
    AgentChatRequest,
    AgentChatSnapshot,
    AgentChatTrackerArtifact,
    AgentChatTurn,
    AgentChatWorkItem,
    AgentToolKind,
    AgentToolOutcome,
} from '@caxri/protocol';
import {
    agentChatActivity,
    agentChatItemStatusSchema,
    emptyAgentChatSnapshot,
    gitChangesDiffTabPath,
    gitCommitFileDiffTabPath,
    gitFileDiffTabPath,
    gitPullRequestChangesDiffTabPath,
    gitPullRequestFileDiffTabPath,
} from '@caxri/protocol';

/**
 * Inputs for `english-counterpart-parity.test.ts`: chosen so both sides of every registered pair reach each branch,
 * enum member, threshold boundary, and truncation case.
 */

export const TOOL_SAMPLES = {
    agent: { name: 'Task', summary: 'Review the diff' },
    browser: { name: 'browserUse', summary: 'Opened the dashboard' },
    command: { name: 'Bash', summary: 'make build' },
    computer: { name: 'computerUse' },
    edit: { name: 'Edit', summary: '/work/src/app.ts' },
    image: { name: 'view_image', summary: '/work/shot.png' },
    list: { name: 'LS', summary: '/work/src' },
    mcp: { name: 'mcp__github__create_issue', summary: '{}' },
    other: { name: 'MysteryTool', summary: 'x' },
    plan: { name: 'TodoWrite' },
    question: { name: 'AskUserQuestion', summary: 'Which?' },
    read: { name: 'Read', summary: '/work/README.md' },
    search: { name: 'Grep', summary: 'TODO' },
    skill: { name: 'Skill', summary: 'commit' },
    stop: { name: 'KillShell', summary: 'shell-1' },
    thought: { name: 'reasoning' },
    wait: { name: 'wait' },
    manage: { name: 'sendMessage' },
    web: { name: 'WebFetch', summary: 'https://example.com' },
    write: { name: 'Write', summary: '/work/new.ts' },
} satisfies Record<AgentToolKind, { name: string; summary?: string }>;

export const TOOL_KINDS = Object.keys(TOOL_SAMPLES) as AgentToolKind[];

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

export const OUTCOMES: AgentToolOutcome[] = ['completed', 'declined', 'failed', 'interrupted'];

export const ITEM_STATUSES = agentChatItemStatusSchema.options;

/**
 * Turn ids that, between them, land on every working phrase (both sides hash the id the same way).
 */
function turnIdsCoveringEveryPhrase(): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < 10_000 && seen.size < 28; index += 1) {
        const id = `turn-${index}`;
        const snapshot = { ...emptyAgentChatSnapshot('chat'), status: 'ready', activeTurnId: id };
        const text = agentChatActivity(snapshot as AgentChatSnapshot, 'Codex')?.text ?? '';
        if (seen.has(text)) continue;
        seen.add(text);
        ids.push(id);
    }
    if (seen.size !== 28) throw new Error(`Covered ${seen.size} of 28 working phrases`);
    return ids;
}

export function activitySnapshots(): Array<{
    snapshot: AgentChatSnapshot | undefined;
    hasConversation?: boolean;
}> {
    const base: AgentChatSnapshot = emptyAgentChatSnapshot('chat');
    const ready: AgentChatSnapshot = { ...base, status: 'ready' };
    const approval: AgentChatRequest = { id: 'r', kind: 'command', command: 'make' };
    const question: AgentChatRequest = {
        id: 'q',
        kind: 'question',
        questions: [{ id: 'q', header: '', question: 'Which?', options: [], allowsOther: true }],
    };
    return [
        { snapshot: undefined },
        { snapshot: undefined, hasConversation: true },
        { snapshot: { ...base, status: 'starting' } },
        { snapshot: ready },
        { snapshot: { ...ready, activeTurnId: 't', requests: [approval] } },
        { snapshot: { ...ready, activeTurnId: 't', requests: [question] } },
        { snapshot: { ...ready, activeTurnId: 't', operation: 'compacting' } },
        { snapshot: { ...ready, operation: 'compacting' } },
        ...turnIdsCoveringEveryPhrase().map((id) => ({
            snapshot: {
                ...ready,
                activeTurnId: id,
                turns: [{ id, status: 'running', startedAt: 1_000 } satisfies AgentChatTurn],
            },
        })),
    ];
}

export const DURATIONS = [
    undefined,
    0,
    499,
    999,
    1_000,
    1_499,
    1_500,
    59_499,
    59_500,
    60_000,
    61_000,
    93_000,
    3_600_000,
    3_661_000,
];

export function workItems(): AgentChatWorkItem[] {
    const change = (path: string, kind: AgentChatFileChange['kind']): AgentChatFileChange => ({
        path,
        kind,
        diff: '',
    });
    return [
        { id: 'r1', type: 'reasoning', text: 'Plain thought', streaming: false },
        { id: 'r2', type: 'reasoning', text: '**Planning the fix**\n\nBody', streaming: true },
        ...ITEM_STATUSES.flatMap((status): AgentChatWorkItem[] => [
            { id: 'c1', type: 'command', command: 'make build', status, output: '' },
            {
                id: 'c2',
                type: 'command',
                command: "/bin/zsh -lc 'git status'",
                description: 'Check the tree',
                status,
                output: '',
            },
            { id: 'c3', type: 'command', command: 'cat src/app.ts', status, output: '' },
            ...Object.values(TOOL_SAMPLES).map((tool): AgentChatWorkItem => ({
                id: 't',
                type: 'toolCall',
                ...tool,
                status,
            })),
            { id: 'f0', type: 'fileChange', status, changes: [] },
            { id: 'f1', type: 'fileChange', status, changes: [change('/p/src/a.ts', 'add')] },
            { id: 'f2', type: 'fileChange', status, changes: [change('/p/src/a.ts', 'update')] },
            { id: 'f3', type: 'fileChange', status, changes: [change('/p/src/a.ts', 'delete')] },
            {
                id: 'f4',
                type: 'fileChange',
                status,
                changes: [change('/p/src/a.ts', 'add'), change('/p/docs/b.md', 'add')],
            },
            {
                id: 'f5',
                type: 'fileChange',
                status,
                changes: [
                    change('/p/src/a.ts', 'update'),
                    change('/p/docs/b.md', 'add'),
                    change('/p/c.md', 'delete'),
                ],
            },
        ]),
    ];
}

export function workGroups(): AgentChatWorkItem[][] {
    const items = workItems();
    const command = (status: AgentChatItemStatus): AgentChatWorkItem => ({
        id: 'c',
        type: 'command',
        command: 'make',
        status,
        output: '',
    });
    return [
        [],
        [items[0]],
        [items[0], items[1]],
        [command('completed')],
        [command('completed'), command('completed')],
        [command('failed'), command('declined'), command('completed')],
        [items[0], ...items.slice(2, 30)],
        items,
    ];
}

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

export const CHANGE_KINDS = Object.keys({
    add: true,
    delete: true,
    update: true,
} satisfies Record<AgentChatFileChange['kind'], true>) as Array<AgentChatFileChange['kind']>;

const question = { id: 'q', header: '', question: 'Which?', options: [], allowsOther: true };

export const APPROVALS = [
    { id: 'r', kind: 'command', command: 'make' },
    { id: 'r', kind: 'command', networkHost: 'a.dev' },
    { id: 'r', kind: 'fileChange', decisions: ['decline', 'cancel', 'accept'] },
    { id: 'r', kind: 'tool', name: 'WebFetch' },
    { id: 'r', kind: 'tool', name: 'ExitPlanMode' },
    { id: 'r', kind: 'tool', name: 'mcp__github__create_issue', summary: '{"title":"x"}' },
    { id: 'r', kind: 'tool', name: 'Edit', summary: '/work/src/app.ts' },
    { id: 'r', kind: 'tool', name: 'WebFetch', summary: `https://example.com/${'a'.repeat(80)}` },
    { id: 'r', kind: 'tool', name: 'Bash', summary: 'git status' },
] satisfies Array<Extract<AgentChatRequest, { kind: 'command' | 'fileChange' | 'tool' }>>;

export const REQUESTS: AgentChatRequest[] = [
    ...APPROVALS,
    { id: 'r', kind: 'question', questions: [question] },
    { id: 'r', kind: 'question', questions: [question, { ...question, id: 'q2' }] },
];

export const DIFF_TAB_PATHS = [
    gitFileDiffTabPath('repo-1', 'src/deep/app.ts'),
    gitPullRequestFileDiffTabPath('repo-1', 'src/app.ts'),
    gitChangesDiffTabPath('repo-1', 'caxri'),
    gitChangesDiffTabPath('repo-1', 'caxri', true),
    gitPullRequestChangesDiffTabPath('repo-1', 'caxri'),
    gitCommitFileDiffTabPath('repo-1', 'a'.repeat(40), 'src/app.ts'),
];
