#!/usr/bin/env bun

import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RECORDS_ROOT = join(PROJECT_ROOT, '.records');
const STATE_ROOT = join(RECORDS_ROOT, 'go');
const SCHEMA_VERSION = 2;
const MAX_EVENTS = 120;

const PHASES = [
    'intake',
    'planning',
    'issue_execution',
    'deep_review',
    'delivery',
    'acceptance',
    'waiting_acceptance',
    'merge',
    'self_improvement',
    'reporting',
    'complete',
] as const;
const ISSUE_STATUSES = [
    'queued',
    'progressing',
    'reviewing',
    'committed',
    'complete',
    'deferred',
] as const;
const PR_STATUSES = [
    'none',
    'draft',
    'open',
    'checks_pending',
    'ready',
    'merged',
    'closed',
] as const;
const ACCEPTANCE_STATUSES = [
    'not_started',
    'running',
    'failed',
    'blocked',
    'pending',
    'rejected',
    'accepted',
] as const;
const NOTE_KINDS = ['technical_debt', 'workflow', 'token_waste'] as const;

const phaseSchema = z.enum(PHASES);
const issueStatusSchema = z.enum(ISSUE_STATUSES);
const pullRequestStatusSchema = z.enum(PR_STATUSES);
const acceptanceStatusSchema = z.enum(ACCEPTANCE_STATUSES);
const noteKindSchema = z.enum(NOTE_KINDS);

type Phase = z.infer<typeof phaseSchema>;
type IssueStatus = z.infer<typeof issueStatusSchema>;
type PullRequestStatus = z.infer<typeof pullRequestStatusSchema>;
type AcceptanceStatus = z.infer<typeof acceptanceStatusSchema>;
type NoteKind = z.infer<typeof noteKindSchema>;

const eventSchema = z.object({ at: z.string(), detail: z.string(), type: z.string() });
const noteSchema = z.object({ at: z.string(), text: z.string() });
const issueSchema = z.object({
    acceptanceCheckIds: z.array(z.string()),
    commits: z.array(z.string()),
    dependencies: z.array(z.number().int().positive()),
    number: z.number().int().positive(),
    priority: z.string().nullable(),
    status: issueStatusSchema,
    title: z.string(),
    validations: z.array(z.string()),
});
const goStateSchema = z.object({
    acceptance: z.object({
        acceptedHeadSha: z.string().nullable(),
        id: z.string().nullable(),
        round: z.number().int().nonnegative(),
        status: acceptanceStatusSchema,
        url: z.string().nullable(),
    }),
    branch: z.string().nullable(),
    createdAt: z.string(),
    events: z.array(eventSchema),
    issues: z.array(issueSchema),
    notes: z.object({
        technical_debt: z.array(noteSchema),
        token_waste: z.array(noteSchema),
        workflow: z.array(noteSchema),
    }),
    objective: z.string().min(1),
    phase: phaseSchema,
    pullRequest: z.object({
        headSha: z.string().nullable(),
        number: z.number().int().positive().nullable(),
        status: pullRequestStatusSchema,
        url: z.string().nullable(),
    }),
    runId: z.string().min(1),
    schemaVersion: z.literal(SCHEMA_VERSION),
    status: z.enum(['planning', 'active', 'waiting_acceptance', 'complete']),
    updatedAt: z.string(),
});

export type GoState = z.infer<typeof goStateSchema>;

interface IssueInput {
    checks?: string[];
    commits?: string[];
    dependencies?: number[];
    number: number;
    priority?: string;
    status?: IssueStatus;
    title?: string;
    validations?: string[];
}

interface PullRequestInput {
    branch?: string;
    headSha?: string;
    number?: number;
    status?: PullRequestStatus;
    url?: string;
}

interface AcceptanceInput {
    acceptedHeadSha?: string;
    id?: string;
    round?: number;
    status?: AcceptanceStatus;
    url?: string;
}

type OptionScalar = string | true;
type OptionValue = OptionScalar | OptionScalar[];
type Options = Record<string, OptionValue>;

const PHASE_TRANSITIONS: Record<Phase, ReadonlySet<Phase>> = {
    acceptance: new Set(['acceptance', 'deep_review', 'issue_execution', 'waiting_acceptance']),
    complete: new Set(),
    deep_review: new Set(['deep_review', 'delivery', 'issue_execution']),
    delivery: new Set(['acceptance', 'deep_review', 'delivery']),
    intake: new Set(['planning']),
    issue_execution: new Set(['deep_review', 'issue_execution']),
    merge: new Set(['deep_review', 'merge', 'self_improvement']),
    planning: new Set(['intake', 'issue_execution']),
    reporting: new Set(['complete']),
    self_improvement: new Set(['reporting']),
    waiting_acceptance: new Set(['acceptance', 'merge', 'waiting_acceptance']),
};

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

function now(): string {
    return new Date().toISOString();
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 36);
}

function defaultRunId(objective: string): string {
    const timestamp = now()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z')
        .replace('T', '-');
    return `${timestamp}-${slugify(objective) || 'goal'}`;
}

function statusForPhase(phase: Phase): GoState['status'] {
    if (phase === 'complete') return 'complete';
    if (phase === 'waiting_acceptance') return 'waiting_acceptance';
    if (phase === 'intake' || phase === 'planning') return 'planning';
    return 'active';
}

function addEvent(state: GoState, type: string, detail: string): void {
    state.events.push({ at: now(), detail, type });
    while (state.events.length > MAX_EVENTS) {
        const removable = state.events.findIndex(
            (event) => event.type !== 'init' && event.type !== 'phase',
        );
        if (removable < 0) break;
        state.events.splice(removable, 1);
    }
}

function uniqueAppend<T>(target: T[], values: T[]): void {
    for (const value of values) {
        if (!target.includes(value)) target.push(value);
    }
}

export function createInitialState({
    branch = null,
    objective,
    runId = defaultRunId(objective),
}: {
    branch?: string | null;
    objective: string;
    runId?: string;
}): GoState {
    const timestamp = now();
    return {
        acceptance: {
            acceptedHeadSha: null,
            id: null,
            round: 0,
            status: 'not_started',
            url: null,
        },
        branch,
        createdAt: timestamp,
        events: [{ at: timestamp, detail: 'Run ledger initialized', type: 'init' }],
        issues: [],
        notes: {
            technical_debt: [],
            token_waste: [],
            workflow: [],
        },
        objective,
        phase: 'intake',
        pullRequest: {
            headSha: null,
            number: null,
            status: 'none',
            url: null,
        },
        runId,
        schemaVersion: SCHEMA_VERSION,
        status: 'planning',
        updatedAt: timestamp,
    };
}

export function transitionState(state: GoState, phase: Phase, reason = ''): GoState {
    const allowed = PHASE_TRANSITIONS[state.phase];
    if (!allowed.has(phase))
        throw new Error(`Invalid phase transition: ${state.phase} -> ${phase}`);

    const previous = state.phase;
    state.phase = phase;
    state.status = statusForPhase(phase);
    addEvent(state, 'phase', `${previous} -> ${phase}${reason ? `: ${reason}` : ''}`);
    return state;
}

export function upsertIssue(state: GoState, input: IssueInput): GoState {
    if (!Number.isInteger(input.number) || input.number <= 0)
        throw new Error('Issue number must be positive');
    if ((input.dependencies ?? []).some((number) => !Number.isInteger(number) || number <= 0)) {
        throw new Error('Issue dependencies must be positive integers');
    }

    let issue = state.issues.find((item) => item.number === input.number);
    if (!issue) {
        if (!input.title) throw new Error('A new issue requires --title');
        issue = {
            acceptanceCheckIds: [],
            commits: [],
            dependencies: [],
            number: input.number,
            priority: input.priority ?? null,
            status: input.status ?? 'queued',
            title: input.title,
            validations: [],
        };
        state.issues.push(issue);
    }

    if (input.title) issue.title = input.title;
    if (input.priority) issue.priority = input.priority;
    if (input.status) issue.status = input.status;
    uniqueAppend(issue.dependencies, input.dependencies ?? []);
    uniqueAppend(issue.commits, input.commits ?? []);
    uniqueAppend(issue.acceptanceCheckIds, input.checks ?? []);
    uniqueAppend(issue.validations, input.validations ?? []);
    addEvent(state, 'issue', `#${issue.number} -> ${issue.status}`);
    return state;
}

export function recordPullRequest(state: GoState, input: PullRequestInput): GoState {
    if (input.number !== undefined && (!Number.isInteger(input.number) || input.number <= 0)) {
        throw new Error('PR number must be positive');
    }

    state.pullRequest = {
        headSha: input.headSha ?? state.pullRequest.headSha,
        number: input.number ?? state.pullRequest.number,
        status: input.status ?? state.pullRequest.status,
        url: input.url ?? state.pullRequest.url,
    };
    if (input.branch) state.branch = input.branch;
    addEvent(
        state,
        'pull_request',
        `PR ${state.pullRequest.number ?? 'unset'} -> ${state.pullRequest.status}`,
    );
    return state;
}

export function recordAcceptance(state: GoState, input: AcceptanceInput): GoState {
    if (input.round !== undefined && (!Number.isInteger(input.round) || input.round < 0)) {
        throw new Error('Acceptance round must be a non-negative integer');
    }

    state.acceptance = {
        acceptedHeadSha: input.acceptedHeadSha ?? state.acceptance.acceptedHeadSha,
        id: input.id ?? state.acceptance.id,
        round: input.round ?? state.acceptance.round,
        status: input.status ?? state.acceptance.status,
        url: input.url ?? state.acceptance.url,
    };
    addEvent(state, 'acceptance', `Round ${state.acceptance.round} -> ${state.acceptance.status}`);
    return state;
}

export function recordNote(
    state: GoState,
    { kind, text }: { kind: NoteKind; text: string },
): GoState {
    if (!text.trim()) throw new Error('Note text is required');
    if (!state.notes[kind].some((item) => item.text === text)) {
        state.notes[kind].push({ at: now(), text });
        addEvent(state, 'note', `${kind}: ${text}`);
    }
    return state;
}

export function validateState(state: unknown): GoState {
    const parsed = goStateSchema.parse(state);
    if (parsed.status !== statusForPhase(parsed.phase)) {
        throw new Error('Invalid Go state: status does not match phase');
    }
    if (new Set(parsed.issues.map((issue) => issue.number)).size !== parsed.issues.length) {
        throw new Error('Invalid Go state: duplicate issue number');
    }
    const unfinishedIssues = parsed.issues.filter(
        (issue) => !['committed', 'complete', 'deferred'].includes(issue.status),
    );
    if (
        !['intake', 'planning', 'issue_execution'].includes(parsed.phase) &&
        unfinishedIssues.length > 0
    ) {
        throw new Error(
            `Invalid Go state: ${parsed.phase} has unfinished issues ${unfinishedIssues.map((issue) => `#${issue.number}`).join(', ')}`,
        );
    }
    if (parsed.acceptance.status === 'accepted' && !parsed.acceptance.acceptedHeadSha) {
        throw new Error('Invalid Go state: accepted Acceptance requires --accepted-head-sha');
    }
    if (
        parsed.phase === 'merge' &&
        (parsed.acceptance.status !== 'accepted' ||
            !parsed.pullRequest.headSha ||
            parsed.pullRequest.headSha !== parsed.acceptance.acceptedHeadSha)
    ) {
        throw new Error('Invalid Go state: merge requires the exact human-accepted PR head');
    }
    return parsed;
}

function parseOptions(argv: string[]): { command: string | undefined; options: Options } {
    const [command, ...tokens] = argv;
    const options: Options = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token.startsWith('--')) throw new Error(`Expected an option, received: ${token}`);
        const key = token.slice(2);
        const next = tokens[index + 1];
        const value: OptionScalar = next && !next.startsWith('--') ? tokens[++index] : true;
        const current = options[key];
        if (current === undefined) options[key] = value;
        else if (Array.isArray(current)) current.push(value);
        else options[key] = [current, value];
    }
    return { command, options };
}

function one(options: Options, key: string, required = false): string | undefined {
    const raw = options[key];
    const value = Array.isArray(raw) ? raw.at(-1) : raw;
    if (required && (value === undefined || value === true || value === '')) {
        throw new Error(`Missing --${key}`);
    }
    return typeof value === 'string' ? value : undefined;
}

function many(options: Options, key: string): string[] {
    const raw = options[key];
    if (raw === undefined) return [];
    return (Array.isArray(raw) ? raw : [raw]).filter(
        (value): value is string => typeof value === 'string',
    );
}

function integer(options: Options, key: string, required = false): number | undefined {
    const value = one(options, key, required);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new Error(`--${key} must be an integer`);
    return parsed;
}

function ensureStatePath(path: string): string {
    const absolutePath = resolve(path);
    const relativePath = relative(resolve(STATE_ROOT), absolutePath);
    if (
        relativePath === '' ||
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
    ) {
        throw new Error(`State path must stay under ${relative(PROJECT_ROOT, STATE_ROOT)}`);
    }
    return absolutePath;
}

async function ensureDirectDirectory(path: string): Promise<void> {
    try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error(
                `Go state directory must not contain symbolic links: ${relative(PROJECT_ROOT, path)}`,
            );
        }
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
        await mkdir(path);
    }
}

async function validateStateRoot(): Promise<string> {
    for (const path of [RECORDS_ROOT, STATE_ROOT]) {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error(
                `Go state directory must not contain symbolic links: ${relative(PROJECT_ROOT, path)}`,
            );
        }
    }
    const [canonicalProjectRoot, canonicalStateRoot] = await Promise.all([
        realpath(PROJECT_ROOT),
        realpath(STATE_ROOT),
    ]);
    const expectedStateRoot = join(canonicalProjectRoot, '.records', 'go');
    if (canonicalStateRoot !== expectedStateRoot) {
        throw new Error('Go state directory must stay inside the project');
    }
    return canonicalStateRoot;
}

/** Verifies each writable ledger ancestor before a run directory is created. */
async function ensureStateRoot(): Promise<string> {
    await ensureDirectDirectory(RECORDS_ROOT);
    await ensureDirectDirectory(STATE_ROOT);
    return validateStateRoot();
}

/** Keeps user-controlled run IDs inside one direct child of the Go ledger directory. */
export function statePathForRunId(runId: string): string {
    if (!runId || runId === '.' || runId === '..' || runId.includes('/') || runId.includes('\\')) {
        throw new Error('Go run ID must be a single path segment');
    }
    return ensureStatePath(resolve(STATE_ROOT, runId, 'state.json'));
}

async function statePathFrom(options: Options): Promise<string> {
    const supplied = one(options, 'state', true);
    if (!supplied) throw new Error('Missing --state');
    const path = ensureStatePath(resolve(PROJECT_ROOT, supplied));
    const canonicalStateRoot = await validateStateRoot();
    const canonicalPath = await realpath(path);
    const relativePath = relative(canonicalStateRoot, canonicalPath);
    if (
        relativePath === '' ||
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
    ) {
        throw new Error(`State path must stay under ${relative(PROJECT_ROOT, STATE_ROOT)}`);
    }
    return path;
}

async function readState(path: string): Promise<GoState> {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    return validateState(raw);
}

async function writeState(path: string, state: GoState): Promise<void> {
    state.updatedAt = now();
    validateState(state);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
}

export async function writeInitialState(path: string, state: GoState): Promise<void> {
    state.updatedAt = now();
    validateState(state);
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
    }).catch((error: unknown) => {
        if (errorCode(error) === 'EEXIST') {
            throw new Error(`Go run already exists: ${relative(PROJECT_ROOT, path)}`);
        }
        throw error;
    });
}

async function prepareRunDirectory(path: string): Promise<void> {
    const canonicalStateRoot = await ensureStateRoot();
    const runDirectory = dirname(path);
    try {
        await mkdir(runDirectory);
    } catch (error: unknown) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const metadata = await lstat(runDirectory);
        if (metadata.isSymbolicLink()) {
            throw new Error('Go run directory must not be a symbolic link', { cause: error });
        }
        throw new Error(`Go run already exists: ${relative(PROJECT_ROOT, path)}`, {
            cause: error,
        });
    }

    const canonicalRunDirectory = await realpath(runDirectory);
    if (dirname(canonicalRunDirectory) !== canonicalStateRoot) {
        throw new Error('Go run directory must stay directly under the Go state directory');
    }
}

function help(): string {
    return `Go run-state ledger

Commands:
  init --objective TEXT [--run-id ID] [--branch NAME]
  phase --state PATH --phase NAME [--reason TEXT]
  issue --state PATH --number N [--title TEXT] [--status STATUS]
        [--priority VALUE] [--dependency N] [--commit SHA]
        [--check ID] [--validation TEXT]
  pr --state PATH [--number N] [--url URL] [--status STATUS] [--branch NAME]
     [--head-sha SHA]
  acceptance --state PATH [--id ID] [--url URL] [--round N] [--status STATUS]
             [--accepted-head-sha SHA]
  note --state PATH --kind technical_debt|workflow|token_waste --text TEXT
  show --state PATH
  validate --state PATH`;
}

async function main(argv: string[]): Promise<void> {
    const { command, options } = parseOptions(argv);
    if (!command || command === 'help' || options.help) {
        console.log(help());
        return;
    }

    if (command === 'init') {
        const objective = one(options, 'objective', true);
        if (!objective) throw new Error('Missing --objective');
        const runId = one(options, 'run-id') ?? defaultRunId(objective);
        const path = statePathForRunId(runId);
        const state = createInitialState({
            branch: one(options, 'branch') ?? null,
            objective,
            runId,
        });
        await prepareRunDirectory(path);
        await writeInitialState(path, state);
        console.log(path);
        return;
    }

    const path = await statePathFrom(options);
    const state = await readState(path);

    if (command === 'show') {
        console.log(JSON.stringify(state, null, 2));
        return;
    }
    if (command === 'validate') {
        console.log('Go state is valid');
        return;
    }
    if (command === 'phase') {
        transitionState(
            state,
            phaseSchema.parse(one(options, 'phase', true)),
            one(options, 'reason') ?? '',
        );
    } else if (command === 'issue') {
        const status = one(options, 'status');
        upsertIssue(state, {
            checks: many(options, 'check'),
            commits: many(options, 'commit'),
            dependencies: many(options, 'dependency').map(Number),
            number: integer(options, 'number', true) ?? 0,
            priority: one(options, 'priority'),
            status: status ? issueStatusSchema.parse(status) : undefined,
            title: one(options, 'title'),
            validations: many(options, 'validation'),
        });
    } else if (command === 'pr') {
        const status = one(options, 'status');
        recordPullRequest(state, {
            branch: one(options, 'branch'),
            headSha: one(options, 'head-sha'),
            number: integer(options, 'number'),
            status: status ? pullRequestStatusSchema.parse(status) : undefined,
            url: one(options, 'url'),
        });
    } else if (command === 'acceptance') {
        const status = one(options, 'status');
        recordAcceptance(state, {
            acceptedHeadSha: one(options, 'accepted-head-sha'),
            id: one(options, 'id'),
            round: integer(options, 'round'),
            status: status ? acceptanceStatusSchema.parse(status) : undefined,
            url: one(options, 'url'),
        });
    } else if (command === 'note') {
        const text = one(options, 'text', true);
        if (!text) throw new Error('Missing --text');
        recordNote(state, { kind: noteKindSchema.parse(one(options, 'kind', true)), text });
    } else {
        throw new Error(`Unknown command: ${command}`);
    }

    await writeState(path, state);
    console.log(path);
}

const invokedPath =
    process.argv[1] && (isAbsolute(process.argv[1]) ? process.argv[1] : resolve(process.argv[1]));
if (invokedPath === SCRIPT_PATH) {
    void main(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
