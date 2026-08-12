#!/usr/bin/env bun

import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { validateHumanText, validateReportLanguage } from './validate-report';
import {
    createTerminalFixturePreflightReceipt,
    terminalFixturePreflightReceiptSchema,
} from './fixture-preflight';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RECORDS_ROOT = join(PROJECT_ROOT, '.records');
const CASE_STATUSES = ['pass', 'fail', 'blocked'] as const;
const DEFAULT_CONCLUSIONS = {
    fail: '当前 PR 头提交未满足全部计划中的桌面验收项。',
    partial: '当前 PR 头提交的桌面验收尚未全部完成。',
    pass: '当前 PR 头提交满足全部计划中的桌面验收项。',
} as const;
const REQUIRED_EVIDENCE_TYPES = [
    'screenshot',
    'gif',
    'video',
    'text',
    'markdown',
    'dom_snapshot',
] as const;

const requiredEvidenceSchema = z.union([
    z.enum(REQUIRED_EVIDENCE_TYPES),
    z.object({ hint: z.string().optional(), type: z.enum(REQUIRED_EVIDENCE_TYPES) }),
]);
const stateIsolationSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('isolated') }),
    z.object({ checkpointId: z.string().min(1), mode: z.literal('readonly_checkpoint') }),
    z.object({
        cleanupOwner: z.literal('final_launch'),
        mode: z.literal('restart'),
        profileId: z.string().min(1),
    }),
]);
const planItemSchema = z
    .object({
        category: z.string().min(1),
        expected: z.string().min(1),
        fixturePreflight: z.literal('terminal').optional(),
        id: z.string().min(1),
        method: z.string().min(1),
        requiredEvidence: z.array(requiredEvidenceSchema).min(1),
        stateIsolation: stateIsolationSchema.default({ mode: 'isolated' }),
        title: z.string().min(1),
        verifier: z.enum(['agent', 'program', 'llm']).default('agent'),
    })
    .passthrough();
const evidenceSchema = z.union([
    z.string().min(1),
    z.object({ path: z.string().min(1) }).passthrough(),
]);
const caseSchema = z
    .object({
        category: z.string().min(1),
        evidence: z.array(evidenceSchema).min(1),
        id: z.string().min(1),
        name: z.string().min(1),
        observation: z.string().min(1),
        status: z.enum(CASE_STATUSES),
        surface: z.literal('desktop'),
    })
    .passthrough();
const resultSchema = z
    .object({
        cases: z.array(caseSchema).min(1),
        entry: z.string().min(1),
        plan: z.array(planItemSchema).min(1),
        requirement: z.string().min(1),
        summary: z.object({ conclusion: z.string().optional() }).passthrough().optional(),
        surfaces: z.array(z.literal('desktop')).min(1),
        title: z.string().min(1),
    })
    .passthrough();

type PlanItem = z.infer<typeof planItemSchema>;
type PlanItemInput = z.input<typeof planItemSchema>;
type AcceptanceCase = z.infer<typeof caseSchema>;
type CaseStatus = (typeof CASE_STATUSES)[number];
type RequiredEvidenceType = (typeof REQUIRED_EVIDENCE_TYPES)[number];
type OptionValue = string | true;
type Options = Record<string, OptionValue>;
export type StateIsolation = z.infer<typeof stateIsolationSchema>;

const lifecycleLaunchSchema = z.object({
    cleanupCompleted: z.boolean(),
    cleanupRequested: z.boolean(),
    completedAt: z.string().nullable(),
    id: z.string().min(1),
    profileIdentity: z.string().min(1),
    ready: z.boolean(),
    startedAt: z.string(),
});
const caseLifecycleReceiptSchema = z.object({
    caseId: z.string().min(1),
    launches: z.array(lifecycleLaunchSchema).min(1),
    profileIdentity: z.string().min(1),
    schemaVersion: z.literal(1),
    stateIsolation: stateIsolationSchema,
});
type CaseLifecycleReceipt = z.infer<typeof caseLifecycleReceiptSchema>;

export interface InitializeReportInput {
    branch?: string;
    commit?: string;
    directory: string;
    entry: string;
    plan: PlanItemInput[];
    pullRequest?: number;
    requirement: string;
    title: string;
}

export interface FinalizeReportInput {
    conclusion?: string;
    directory: string;
    requirement: string;
}

function assertUniqueIds(items: Array<{ id: string }>, kind: string): void {
    const duplicate = items.find(
        (item, index) => items.findIndex(({ id }) => id === item.id) !== index,
    );
    if (duplicate) throw new Error(`Duplicate ${kind} id: ${duplicate.id}`);
}

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

function inside(parent: string, candidate: string): boolean {
    const path = relative(parent, candidate);
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function resolveReportDirectory(path: string): string {
    const directory = resolve(PROJECT_ROOT, path);
    if (!inside(RECORDS_ROOT, directory)) {
        throw new Error('Acceptance report directory must stay under .records/');
    }
    if (!/^round-[1-9]\d*$/.test(basename(directory))) {
        throw new Error('Acceptance report directory must end with round-<positive integer>');
    }
    return directory;
}

async function ensureDirectDirectory(path: string): Promise<void> {
    try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error(
                `Acceptance report path must not contain symbolic links: ${relative(PROJECT_ROOT, path)}`,
            );
        }
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
        await mkdir(path);
    }
}

async function validateRecordsRoot(): Promise<string> {
    const metadata = await lstat(RECORDS_ROOT);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('Acceptance report path must not contain symbolic links: .records');
    }
    const [canonicalProjectRoot, canonicalRecordsRoot] = await Promise.all([
        realpath(PROJECT_ROOT),
        realpath(RECORDS_ROOT),
    ]);
    if (canonicalRecordsRoot !== join(canonicalProjectRoot, '.records')) {
        throw new Error('Acceptance report directory must stay under .records/');
    }
    return canonicalRecordsRoot;
}

async function prepareReportParent(directory: string): Promise<string> {
    await ensureDirectDirectory(RECORDS_ROOT);
    const parent = dirname(directory);
    const parentSegments = relative(RECORDS_ROOT, parent).split(sep).filter(Boolean);
    let current = RECORDS_ROOT;
    for (const segment of parentSegments) {
        current = join(current, segment);
        await ensureDirectDirectory(current);
    }
    const canonicalRecordsRoot = await validateRecordsRoot();
    const canonicalParent = await realpath(parent);
    if (!inside(canonicalRecordsRoot, canonicalParent)) {
        throw new Error('Acceptance report directory must stay under .records/');
    }
    return parent;
}

async function validateExistingReportDirectory(path: string): Promise<string> {
    const directory = resolveReportDirectory(path);
    await validateRecordsRoot();
    const segments = relative(RECORDS_ROOT, directory).split(sep);
    let current = RECORDS_ROOT;
    for (const segment of segments) {
        current = join(current, segment);
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error(
                `Acceptance report path must not contain symbolic links: ${relative(PROJECT_ROOT, current)}`,
            );
        }
    }
    const [canonicalRecordsRoot, canonicalDirectory] = await Promise.all([
        realpath(RECORDS_ROOT),
        realpath(directory),
    ]);
    if (!inside(canonicalRecordsRoot, canonicalDirectory)) {
        throw new Error('Acceptance report directory must stay under .records/');
    }
    return directory;
}

function lifecycleEvidencePath(caseId: string): string {
    return `assets/${encodeURIComponent(caseId)}-state-isolation.json`;
}

function preflightEvidencePath(caseId: string): string {
    return `assets/${encodeURIComponent(caseId)}-fixture-preflight.json`;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
}

export async function loadAcceptanceCasePlan(
    reportDirectory: string,
    caseId: string,
): Promise<{ directory: string; item: PlanItem }> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const raw: unknown = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    const plan = z.object({ plan: z.array(planItemSchema).min(1) }).parse(raw).plan;
    const item = plan.find(({ id }) => id === caseId);
    if (!item) throw new Error(`Acceptance case ${caseId} is not present in the frozen plan`);
    return { directory, item };
}

export function validateAcceptanceCaseLaunch(
    stateIsolation: StateIsolation,
    input: { caseMode: 'isolated' | 'restart'; cleanupReusable: boolean; reuseUserData: boolean },
): { profileId?: string } {
    if (stateIsolation.mode === 'readonly_checkpoint') {
        throw new Error('Readonly checkpoint cases require a checkpoint-aware launch adapter');
    }
    if (stateIsolation.mode === 'isolated') {
        if (input.caseMode !== 'isolated' || input.reuseUserData || input.cleanupReusable) {
            throw new Error('An isolated Acceptance case cannot reuse a profile');
        }
        return {};
    }
    if (input.caseMode !== 'restart' || !input.reuseUserData) {
        throw new Error('A declared restart case must reuse its frozen profile');
    }
    return { profileId: stateIsolation.profileId };
}

export async function beginCaseLifecycle(
    reportDirectory: string,
    input: { caseId: string; profileIdentity: string; stateIsolation: StateIsolation },
    startedAt = new Date().toISOString(),
): Promise<string> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const path = join(directory, lifecycleEvidencePath(input.caseId));
    let receipt: CaseLifecycleReceipt;
    try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
            throw new Error('Acceptance lifecycle receipt must be a direct regular file');
        }
        receipt = caseLifecycleReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        if (
            receipt.caseId !== input.caseId ||
            JSON.stringify(receipt.stateIsolation) !== JSON.stringify(input.stateIsolation)
        ) {
            throw new Error('Acceptance lifecycle receipt does not match the frozen case profile');
        }
        if (receipt.launches.some(({ completedAt }) => completedAt === null)) {
            throw new Error('Previous Acceptance case launch has not completed');
        }
        if (input.stateIsolation.mode === 'isolated') {
            if (receipt.launches.some(({ ready }) => ready)) {
                throw new Error('An isolated Acceptance case already has a completed ready launch');
            }
            if (
                receipt.launches.some(
                    ({ cleanupCompleted, cleanupRequested }) =>
                        !cleanupRequested || !cleanupCompleted,
                )
            ) {
                throw new Error('A failed isolated launch must clean up before retry');
            }
            receipt.profileIdentity = input.profileIdentity;
        } else {
            if (receipt.profileIdentity !== input.profileIdentity) {
                throw new Error(
                    'Acceptance lifecycle receipt does not match the frozen case profile',
                );
            }
            if (receipt.launches.at(-1)?.cleanupCompleted) {
                throw new Error('Acceptance restart profile was already cleaned up');
            }
        }
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
        receipt = {
            caseId: input.caseId,
            launches: [],
            profileIdentity: input.profileIdentity,
            schemaVersion: 1,
            stateIsolation: input.stateIsolation,
        };
    }
    const launchId = randomUUID();
    receipt.launches.push({
        cleanupCompleted: false,
        cleanupRequested: false,
        completedAt: null,
        id: launchId,
        profileIdentity: input.profileIdentity,
        ready: false,
        startedAt,
    });
    await writeJsonAtomically(path, caseLifecycleReceiptSchema.parse(receipt));
    return launchId;
}

export async function markCaseLifecycleReady(
    reportDirectory: string,
    input: { caseId: string; launchId: string },
): Promise<void> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const path = join(directory, lifecycleEvidencePath(input.caseId));
    const receipt = caseLifecycleReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const launch = receipt.launches.find(({ id }) => id === input.launchId);
    if (!launch || launch.completedAt) throw new Error('Acceptance lifecycle launch is not active');
    launch.ready = true;
    await writeJsonAtomically(path, receipt);
}

export async function completeCaseLifecycle(
    reportDirectory: string,
    input: {
        caseId: string;
        cleanupCompleted: boolean;
        cleanupRequested: boolean;
        launchId: string;
    },
    completedAt = new Date().toISOString(),
): Promise<void> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const path = join(directory, lifecycleEvidencePath(input.caseId));
    const receipt = caseLifecycleReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const launch = receipt.launches.find(({ id }) => id === input.launchId);
    if (!launch || launch.completedAt)
        throw new Error('Acceptance lifecycle launch is not pending');
    launch.cleanupRequested = input.cleanupRequested;
    launch.cleanupCompleted = input.cleanupCompleted;
    launch.completedAt = completedAt;
    await writeJsonAtomically(path, receipt);
}

async function freezeRequirement(parent: string, requirement: string): Promise<void> {
    const path = join(parent, 'requirement.txt');
    const expected = `${requirement}\n`;
    try {
        await writeFile(path, expected, { encoding: 'utf8', flag: 'wx' });
    } catch (error: unknown) {
        if (errorCode(error) !== 'EEXIST') throw error;
        if ((await readFrozenRequirement(parent)) !== expected) {
            throw new Error('Acceptance requirement must match the frozen requirement', {
                cause: error,
            });
        }
    }
}

async function readFrozenRequirement(parent: string): Promise<string> {
    const path = join(parent, 'requirement.txt');
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Frozen Acceptance requirement must be a regular file');
    }
    return readFile(path, 'utf8');
}

function normalizePlanLanguage(plan: PlanItem[]): PlanItem[] {
    return plan.map((item, index) => ({
        ...item,
        category: validateHumanText(item.category, `plan[${index}].category`),
        expected: validateHumanText(item.expected, `plan[${index}].expected`),
        method: validateHumanText(item.method, `plan[${index}].method`),
        title: validateHumanText(item.title, `plan[${index}].title`),
    }));
}

async function assertFreshRound(directory: string): Promise<void> {
    try {
        await lstat(directory);
        throw new Error(`Acceptance report already exists: ${directory}`);
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
    }
}

export async function initializeReport(input: InitializeReportInput): Promise<string> {
    const directory = resolveReportDirectory(input.directory);
    const parsedPlan = normalizePlanLanguage(z.array(planItemSchema).min(1).parse(input.plan));
    assertUniqueIds(parsedPlan, 'plan');
    const requirement = validateHumanText(input.requirement, 'requirement');
    const title = validateHumanText(input.title, 'title');
    const entry = validateHumanText(input.entry, 'entry');

    const parent = await prepareReportParent(directory);
    await assertFreshRound(directory);
    await freezeRequirement(parent, requirement);
    try {
        await mkdir(directory);
    } catch (error: unknown) {
        if (errorCode(error) === 'EEXIST') {
            throw new Error(`Acceptance report already exists: ${directory}`, { cause: error });
        }
        throw error;
    }
    await validateExistingReportDirectory(directory);
    await mkdir(join(directory, 'assets'));

    const resultPath = join(directory, 'result.json');
    const notesPath = join(directory, 'report.md');

    const result = {
        ...(input.branch ? { branch: input.branch } : {}),
        cases: parsedPlan.map(({ category, id, title }) => ({
            category,
            evidence: [],
            id,
            name: title,
            observation: '',
            status: 'TODO',
            surface: 'desktop',
        })),
        ...(input.commit ? { commit: input.commit } : {}),
        createdAt: new Date().toISOString(),
        entry,
        plan: parsedPlan,
        ...(input.pullRequest ? { pullRequest: { number: input.pullRequest } } : {}),
        requirement,
        surfaces: ['desktop'],
        title,
    };
    const notes = '本轮暂无补充说明。\n';
    await Promise.all([
        writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
        }),
        writeFile(notesPath, notes, { encoding: 'utf8', flag: 'wx' }),
    ]);
    return resultPath;
}

function evidencePath(evidence: z.infer<typeof evidenceSchema>): string {
    return typeof evidence === 'string' ? evidence : evidence.path;
}

function evidenceTypeForPath(path: string): RequiredEvidenceType {
    const extension = extname(path).toLowerCase();
    if (extension === '.gif') return 'gif';
    if (['.png', '.jpg', '.jpeg', '.webp', '.svg', '.bmp'].includes(extension)) {
        return 'screenshot';
    }
    if (['.mp4', '.webm', '.mov', '.m4v'].includes(extension)) return 'video';
    if (['.html', '.htm'].includes(extension)) return 'dom_snapshot';
    if (['.md', '.markdown'].includes(extension)) return 'markdown';
    return 'text';
}

function assertNoTodoCases(report: unknown): void {
    const parsed = z
        .object({ cases: z.array(z.object({ id: z.string(), status: z.unknown() })) })
        .safeParse(report);
    if (!parsed.success) return;
    const placeholder = parsed.data.cases.find(({ status }) => status === 'TODO');
    if (placeholder) throw new Error(`Case ${placeholder.id} is still a TODO placeholder`);
}

async function validateEvidenceFile(directory: string, evidence: string): Promise<string> {
    if (isAbsolute(evidence)) throw new Error(`Evidence path must be relative: ${evidence}`);
    const normalized = evidence.split('\\').join('/');
    if (normalized !== 'assets' && !normalized.startsWith('assets/')) {
        throw new Error(`Evidence path must stay under assets/: ${evidence}`);
    }
    const canonicalAssets = await realpath(join(directory, 'assets'));
    const canonicalEvidence = await realpath(resolve(directory, evidence)).catch(() => {
        throw new Error(`Evidence file does not exist: ${evidence}`);
    });
    if (!inside(canonicalAssets, canonicalEvidence)) {
        throw new Error(`Evidence path must stay under assets/: ${evidence}`);
    }
    const metadata = await lstat(canonicalEvidence);
    if (!metadata.isFile()) throw new Error(`Evidence path is not a file: ${evidence}`);
    return evidenceTypeForPath(evidence);
}

function requiredEvidenceTypes(plan: PlanItem): RequiredEvidenceType[] {
    return plan.requiredEvidence.map((evidence) =>
        typeof evidence === 'string' ? evidence : evidence.type,
    );
}

async function validateFixturePreflightEvidence(
    directory: string,
    plan: PlanItem,
    acceptanceCase: AcceptanceCase,
): Promise<void> {
    if (plan.fixturePreflight !== 'terminal') return;
    const evidence = preflightEvidencePath(plan.id);
    if (!acceptanceCase.evidence.some((item) => evidencePath(item) === evidence)) {
        throw new Error(`Case ${plan.id} must include its fixture preflight receipt`);
    }
    const receipt = terminalFixturePreflightReceiptSchema.parse(
        JSON.parse(await readFile(join(directory, evidence), 'utf8')),
    );
    const verified = createTerminalFixturePreflightReceipt(receipt.fixture, receipt.caseId);
    if (
        receipt.caseId !== plan.id ||
        receipt.result.status !== 'ready' ||
        JSON.stringify(receipt) !== JSON.stringify(verified)
    ) {
        throw new Error(`Case ${plan.id} fixture preflight is blocked`);
    }
}

async function validateCaseLifecycleEvidence(
    directory: string,
    plan: PlanItem,
    acceptanceCase: AcceptanceCase,
): Promise<void> {
    if (plan.stateIsolation.mode === 'readonly_checkpoint') return;
    const evidence = lifecycleEvidencePath(plan.id);
    if (!acceptanceCase.evidence.some((item) => evidencePath(item) === evidence)) {
        throw new Error(`Case ${plan.id} must include its state-isolation receipt`);
    }
    const receipt = caseLifecycleReceiptSchema.parse(
        JSON.parse(await readFile(join(directory, evidence), 'utf8')),
    );
    if (
        receipt.caseId !== plan.id ||
        JSON.stringify(receipt.stateIsolation) !== JSON.stringify(plan.stateIsolation) ||
        receipt.launches.some(({ completedAt }) => completedAt === null)
    ) {
        throw new Error(`Case ${plan.id} state-isolation receipt does not match the frozen plan`);
    }
    if (plan.stateIsolation.mode === 'isolated') {
        const readyLaunches = receipt.launches.filter(({ ready }) => ready);
        if (
            readyLaunches.length !== 1 ||
            receipt.launches.some(
                ({ cleanupCompleted, cleanupRequested }) => !cleanupRequested || !cleanupCompleted,
            )
        ) {
            throw new Error(`Case ${plan.id} isolated profile was not cleaned up`);
        }
        return;
    }
    const finalLaunch = receipt.launches.at(-1);
    const readyLaunches = receipt.launches.filter(({ ready }) => ready);
    const priorReadyLaunches = readyLaunches.slice(0, -1);
    const finalReadyLaunch = readyLaunches.at(-1);
    if (
        readyLaunches.length < 2 ||
        receipt.profileIdentity !== plan.stateIsolation.profileId ||
        priorReadyLaunches.some(({ cleanupCompleted, cleanupRequested }) =>
            Boolean(cleanupCompleted || cleanupRequested),
        ) ||
        finalLaunch !== finalReadyLaunch ||
        !finalReadyLaunch?.cleanupRequested ||
        !finalReadyLaunch.cleanupCompleted
    ) {
        throw new Error(`Case ${plan.id} restart profile lifecycle is incomplete`);
    }
}

function summaryFor(cases: AcceptanceCase[], conclusion?: string) {
    const counts: Record<CaseStatus, number> = { blocked: 0, fail: 0, pass: 0 };
    for (const item of cases) counts[item.status] += 1;
    const verdict = counts.fail > 0 ? 'fail' : counts.blocked > 0 ? 'partial' : 'pass';
    return {
        blocked: counts.blocked,
        conclusion: conclusion ?? DEFAULT_CONCLUSIONS[verdict],
        failed: counts.fail,
        passed: counts.pass,
        total: cases.length,
        verdict,
    };
}

export async function finalizeReport(input: FinalizeReportInput) {
    const directory = await validateExistingReportDirectory(input.directory);
    const resultPath = join(directory, 'result.json');
    const notesPath = join(directory, 'report.md');
    const [rawResult, notes] = await Promise.all([
        readFile(resultPath, 'utf8'),
        readFile(notesPath, 'utf8'),
    ]);
    const rawReport: unknown = JSON.parse(rawResult);
    const storedRequirement = z.object({ requirement: z.string() }).parse(rawReport).requirement;
    const requirement = validateHumanText(input.requirement, 'requirement');
    if (
        storedRequirement !== requirement ||
        (await readFrozenRequirement(dirname(directory))) !== `${requirement}\n`
    ) {
        throw new Error('Acceptance requirement must match the frozen requirement');
    }
    assertNoTodoCases(rawReport);
    const report = resultSchema.parse(rawReport);
    assertUniqueIds(report.plan, 'plan');
    assertUniqueIds(report.cases, 'case');

    const planIds = report.plan.map(({ id }) => id);
    const caseIds = report.cases.map(({ id }) => id);
    if (planIds.length !== caseIds.length || planIds.some((id, index) => id !== caseIds[index])) {
        throw new Error('Case ids and order must exactly match the frozen plan');
    }

    for (const [index, item] of report.cases.entries()) {
        const planned = report.plan[index];
        if (item.name !== planned.title || item.category !== planned.category) {
            throw new Error(`Case ${item.id} title and category must match the frozen plan`);
        }
        const actualTypes = new Set<string>();
        for (const evidence of item.evidence) {
            actualTypes.add(await validateEvidenceFile(directory, evidencePath(evidence)));
        }
        const missing = requiredEvidenceTypes(planned).filter(
            (required) => !actualTypes.has(required),
        );
        if (missing.length > 0) {
            throw new Error(`Case ${item.id} is missing required evidence: ${missing.join(', ')}`);
        }
        await validateFixturePreflightEvidence(directory, planned, item);
        await validateCaseLifecycleEvidence(directory, planned, item);
    }

    const previousConclusion = report.summary?.conclusion?.trim();
    const customConclusion =
        previousConclusion &&
        !Object.values(DEFAULT_CONCLUSIONS).includes(
            previousConclusion as (typeof DEFAULT_CONCLUSIONS)[keyof typeof DEFAULT_CONCLUSIONS],
        )
            ? previousConclusion
            : undefined;
    const requestedConclusion = input.conclusion
        ? validateHumanText(input.conclusion, 'conclusion')
        : undefined;
    const summary = {
        ...(report.summary ?? {}),
        ...summaryFor(report.cases, requestedConclusion ?? customConclusion),
    };
    const finalized = { ...report, summary };
    validateReportLanguage({ notes, report: finalized, requirement });
    const temporaryPath = `${resultPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(finalized, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, resultPath);
    return finalized;
}

function parseOptions(tokens: string[]): Options {
    const options: Options = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token.startsWith('--')) throw new Error(`Expected an option, received: ${token}`);
        const key = token.slice(2);
        const next = tokens[index + 1];
        options[key] = next && !next.startsWith('--') ? tokens[++index] : true;
    }
    return options;
}

function option(options: Options, key: string, required = false): string | undefined {
    const value = options[key];
    if (required && (typeof value !== 'string' || value.length === 0)) {
        throw new Error(`Missing --${key}`);
    }
    return typeof value === 'string' ? value : undefined;
}

async function readPlan(path: string): Promise<PlanItem[]> {
    const value: unknown = JSON.parse(await readFile(resolve(path), 'utf8'));
    const plan = Array.isArray(value)
        ? value
        : value && typeof value === 'object' && 'plan' in value
          ? value.plan
          : value;
    return z.array(planItemSchema).min(1).parse(plan);
}

function help(): string {
    return `Caxri Acceptance report scaffold

Commands:
  init --dir DIR --plan PLAN_JSON --title TEXT --entry TEXT --requirement TEXT
       [--branch NAME] [--commit SHA] [--pull-request N]
  finalize --dir DIR --requirement TEXT [--conclusion TEXT]`;
}

async function main(argv: string[]): Promise<void> {
    const [command, ...tokens] = argv;
    if (!command || command === 'help' || command === '--help' || tokens.includes('--help')) {
        console.log(help());
        return;
    }
    if (command !== 'init' && command !== 'finalize') {
        throw new Error(`Unknown command: ${command}`);
    }
    const options = parseOptions(tokens);
    const directory = option(options, 'dir', true);
    const requirement = option(options, 'requirement', true);
    if (!directory || !requirement) throw new Error('Missing report directory or requirement');

    if (command === 'init') {
        const planPath = option(options, 'plan', true);
        const title = option(options, 'title', true);
        const entry = option(options, 'entry', true);
        if (!planPath || !title || !entry) throw new Error('Missing report scaffold input');
        const pullRequestRaw = option(options, 'pull-request');
        const pullRequest = pullRequestRaw === undefined ? undefined : Number(pullRequestRaw);
        if (pullRequest !== undefined && (!Number.isInteger(pullRequest) || pullRequest <= 0)) {
            throw new Error('--pull-request must be a positive integer');
        }
        const path = await initializeReport({
            branch: option(options, 'branch'),
            commit: option(options, 'commit'),
            directory,
            entry,
            plan: await readPlan(planPath),
            pullRequest,
            requirement,
            title,
        });
        console.log(path);
        return;
    }
    if (command === 'finalize') {
        const report = await finalizeReport({
            conclusion: option(options, 'conclusion'),
            directory,
            requirement,
        });
        console.log(JSON.stringify(report.summary, null, 2));
        return;
    }
}

const invokedPath =
    process.argv[1] && (isAbsolute(process.argv[1]) ? process.argv[1] : resolve(process.argv[1]));
if (invokedPath === SCRIPT_PATH) {
    void main(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
