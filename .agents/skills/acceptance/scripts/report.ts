import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { validateAgentFixtureEvidence } from './agent-fixture-lifecycle';
import { acceptanceAgentFixtureIds } from './agent-fixtures';
import type { StateIsolation } from './case-lifecycle';
import {
    caseLifecycleReceiptSchema,
    lifecycleEvidencePath,
    repairCaseLifecycle,
    stateIsolationSchema,
} from './case-lifecycle';
import {
    createTerminalFixturePreflightReceipt,
    terminalFixturePreflightReceiptSchema,
} from './fixture-preflight';
import { validateReportMediaEvidence } from './media-integrity';
import {
    hasMobileDeviceReceipt,
    mobileDeviceSchema,
    validateMobileEvidence,
} from './mobile-report';
import { changedPathsBetween } from './rebind-delta';
import type { RebindReportHeadInput } from './report-head';
import { rebindReportDocument } from './report-head';
import { reportCliHelp } from './report-help';
import {
    errorCode,
    isInside,
    prepareReportParent,
    PROJECT_ROOT,
    resolveReportDirectory,
    validateExistingReportDirectory,
    writeJsonAtomically,
} from './report-paths';
import { assertUniqueAcceptanceCaseIds, isAcceptanceCaseId } from './runtime-state';
import { validateHumanText, validateReportLanguage } from './validate-report';

export type { RebindReportHeadInput } from './report-head';
const CASE_STATUSES = ['pass', 'fail', 'blocked'] as const;
const PRODUCT_SURFACES = ['desktop', 'mobile'] as const;
const DEFAULT_CONCLUSIONS = {
    fail: '当前 PR 头提交未满足全部计划中的验收项。',
    partial: '当前 PR 头提交的验收尚未全部完成。',
    pass: '当前 PR 头提交满足全部计划中的验收项。',
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
const planItemSchema = z
    .looseObject({
        agentFixture: z.enum(acceptanceAgentFixtureIds).optional(),
        category: z.string().min(1),
        expected: z.string().min(1),
        fixturePreflight: z.literal('terminal').optional(),
        id: z.string().min(1).refine(isAcceptanceCaseId, {
            message: 'Acceptance case id must use ASCII letters, numbers, and hyphens',
        }),
        method: z.string().min(1),
        mobileDevice: mobileDeviceSchema.optional(),
        requiredEvidence: z.array(requiredEvidenceSchema).min(1),
        stateIsolation: stateIsolationSchema.default({ mode: 'isolated' }),
        surface: z.enum(PRODUCT_SURFACES).default('desktop'),
        title: z.string().min(1),
        verifier: z.enum(['agent', 'program', 'llm']).default('agent'),
    })
    .superRefine((item, context) => {
        if (item.surface === 'mobile' && !item.mobileDevice) {
            context.addIssue({
                code: 'custom',
                message: 'A mobile Acceptance case must declare mobileDevice',
                path: ['mobileDevice'],
            });
        }
        if (item.surface === 'desktop' && item.mobileDevice) {
            context.addIssue({
                code: 'custom',
                message: 'A desktop Acceptance case cannot declare mobileDevice',
                path: ['mobileDevice'],
            });
        }
    });
const evidenceSchema = z.union([z.string().min(1), z.looseObject({ path: z.string().min(1) })]);
const caseSchema = z.looseObject({
    category: z.string().min(1),
    evidence: z.array(evidenceSchema).min(1),
    id: z.string().min(1),
    name: z.string().min(1),
    observation: z.string().min(1),
    status: z.enum(CASE_STATUSES),
    surface: z.enum(PRODUCT_SURFACES),
});
const resultSchema = z.looseObject({
    cases: z.array(caseSchema).min(1),
    entry: z.string().min(1),
    plan: z.array(planItemSchema).min(1),
    requirement: z.string().min(1),
    summary: z.looseObject({ conclusion: z.string().optional() }).optional(),
    surfaces: z.array(z.enum(PRODUCT_SURFACES)).min(1),
    title: z.string().min(1),
});

type PlanItem = z.infer<typeof planItemSchema>;
type PlanItemInput = z.input<typeof planItemSchema>;
type AcceptanceCase = z.infer<typeof caseSchema>;
type CaseStatus = (typeof CASE_STATUSES)[number];
type RequiredEvidenceType = (typeof REQUIRED_EVIDENCE_TYPES)[number];
type OptionValue = string | true;
type Options = Record<string, OptionValue>;
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
function preflightEvidencePath(caseId: string): string {
    return `assets/${encodeURIComponent(caseId)}-fixture-preflight.json`;
}

/**
 * Suffixes of the receipts that only record that the adapter's own machinery ran — which profile was used, that the
 * fixture came up, that cleanup completed. They say nothing about what the product did, so they cannot stand in for an
 * observation. The mobile device receipt is deliberately absent: it carries an `outcome`, which is a real record of
 * what happened on the selected target.
 */
const LIFECYCLE_RECEIPT_SUFFIXES = [
    '-state-isolation.json',
    '-fixture-preflight.json',
    '-agent-fixture.json',
] as const;

function isLifecycleReceipt(path: string): boolean {
    return LIFECYCLE_RECEIPT_SUFFIXES.some((suffix) => path.endsWith(suffix));
}
export async function loadAcceptanceCasePlan(
    reportDirectory: string,
    caseId: string,
): Promise<{ commit: string; directory: string; item: PlanItem }> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const raw: unknown = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    const { commit, plan } = z
        .object({ commit: z.string().trim().min(1), plan: z.array(planItemSchema).min(1) })
        .parse(raw);
    const item = plan.find(({ id }) => id === caseId);
    if (!item) throw new Error(`Acceptance case ${caseId} is not present in the frozen plan`);
    return { commit, directory, item };
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
    assertUniqueAcceptanceCaseIds(parsedPlan, 'plan');
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
        ...(input.branch && { branch: input.branch }),
        cases: parsedPlan.map(({ category, id, surface, title }) => ({
            category,
            evidence: [],
            id,
            name: title,
            observation: '',
            status: 'TODO',
            surface,
        })),
        ...(input.commit && { commit: input.commit }),
        createdAt: new Date().toISOString(),
        entry,
        plan: parsedPlan,
        ...(input.pullRequest && { pullRequest: { number: input.pullRequest } }),
        requirement,
        surfaces: [...new Set(parsedPlan.map(({ surface }) => surface))],
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

/**
 * Rebinds an unfinished local round without reconstructing generated JSON by hand. The expected old head makes stale
 * callers fail closed, while the audit entry keeps the evidence lineage visible when a non-product repair changes the
 * exact delivery head before publication.
 */
export async function rebindReportHead(input: RebindReportHeadInput): Promise<void> {
    const directory = await validateExistingReportDirectory(input.directory);
    const resultPath = join(directory, 'result.json');
    const raw: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
    await writeJsonAtomically(resultPath, rebindReportDocument(raw, input));
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

const todoCaseSchema = z.object({ id: z.string(), status: z.unknown() });

function assertNoTodoCases(report: unknown): void {
    const parsed = z.object({ cases: z.array(todoCaseSchema) }).safeParse(report);
    if (!parsed.success) return;
    const placeholder = parsed.data.cases.find(({ status }) => status === 'TODO');
    if (placeholder) throw new Error(`Case ${placeholder.id} is still a TODO placeholder`);
}

async function validateEvidenceFile(directory: string, evidence: string): Promise<string> {
    if (isAbsolute(evidence)) throw new Error(`Evidence path must be relative: ${evidence}`);
    const normalized = evidence.replaceAll('\\', '/');
    if (normalized !== 'assets' && !normalized.startsWith('assets/')) {
        throw new Error(`Evidence path must stay under assets/: ${evidence}`);
    }
    const canonicalAssets = await realpath(join(directory, 'assets'));
    let canonicalEvidence: string;
    try {
        canonicalEvidence = await realpath(resolve(directory, evidence));
    } catch {
        throw new Error(`Evidence file does not exist: ${evidence}`);
    }
    if (!isInside(canonicalAssets, canonicalEvidence)) {
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

/**
 * Reads one receipt that only exists because the case actually executed — a launch lifecycle or a fixture preflight.
 * The adapter writes it during execution, so a case blocked before that point cannot have one, and demanding it
 * unconditionally would leave the honest blocked round `SKILL.md` asks for impossible to finalize. Absence is accepted
 * only for `blocked`; the moment the file exists the case did execute, so it must declare the receipt and pass every
 * check below. Returns `null` when the case is legitimately blocked without the receipt.
 */
async function readExecutionReceipt(
    directory: string,
    evidence: string,
    acceptanceCase: AcceptanceCase,
    missingMessage: string,
): Promise<string | null> {
    let rawReceipt: string;
    try {
        rawReceipt = await readFile(join(directory, evidence), 'utf8');
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
        if (acceptanceCase.status === 'blocked') return null;
        /**
         * A case that reached a verdict but never produced the receipt is the ordinary authoring mistake, so it still
         * gets the contract message rather than a bare ENOENT. A declared path that is missing on disk was already
         * rejected by the per-file evidence check.
         */
        throw new Error(missingMessage, { cause: error });
    }
    if (acceptanceCase.evidence.every((item) => evidencePath(item) !== evidence)) {
        throw new Error(missingMessage);
    }
    return rawReceipt;
}

async function validateFixturePreflightEvidence(
    directory: string,
    plan: PlanItem,
    acceptanceCase: AcceptanceCase,
): Promise<void> {
    if (plan.fixturePreflight !== 'terminal') return;
    const rawReceiptText = await readExecutionReceipt(
        directory,
        preflightEvidencePath(plan.id),
        acceptanceCase,
        `Case ${plan.id} must include its fixture preflight receipt`,
    );
    if (rawReceiptText === null) return;
    const rawReceipt: unknown = JSON.parse(rawReceiptText);
    const receipt = terminalFixturePreflightReceiptSchema.parse(rawReceipt);
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
    const rawReceiptText = await readExecutionReceipt(
        directory,
        lifecycleEvidencePath(plan.id),
        acceptanceCase,
        `Case ${plan.id} must include its state-isolation receipt`,
    );
    if (rawReceiptText === null) return;
    const rawReceipt: unknown = JSON.parse(rawReceiptText);
    const receipt = caseLifecycleReceiptSchema.parse(rawReceipt);
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
            (acceptanceCase.status === 'pass' && readyLaunches.length === 0) ||
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
        finalLaunch !== finalReadyLaunch ||
        readyLaunches.length < 2 ||
        receipt.profileIdentity !== plan.stateIsolation.profileId ||
        priorReadyLaunches.some(
            ({ cleanupCompleted, cleanupRequested }) => cleanupCompleted || cleanupRequested,
        ) ||
        !finalReadyLaunch?.cleanupRequested ||
        !finalReadyLaunch.cleanupCompleted
    ) {
        throw new Error(`Case ${plan.id} restart profile lifecycle is incomplete`);
    }
}

async function validateMobileDeviceEvidence(
    directory: string,
    plan: PlanItem,
    acceptanceCase: AcceptanceCase,
    reportCommit: string | undefined,
): Promise<void> {
    if (plan.surface !== 'mobile') return;
    const expectedDevice = plan.mobileDevice;
    if (!expectedDevice) throw new Error(`Case ${plan.id} is missing its mobile device plan`);
    /**
     * A mobile case blocked before the selected target ever ran has no device receipt and no launch lifecycle to read,
     * so demanding either would make the honest blocked round impossible to finalize on mobile exactly as it was on
     * desktop. The receipt on disk is the proof it ran.
     */
    if (
        acceptanceCase.status === 'blocked' &&
        !(await hasMobileDeviceReceipt(directory, plan.id))
    ) {
        return;
    }
    let evidenceBinding: { checkpointId: string } | { launchId: string };
    if (plan.stateIsolation.mode === 'readonly_checkpoint') {
        evidenceBinding = { checkpointId: plan.stateIsolation.checkpointId };
    } else {
        const lifecyclePath = join(directory, lifecycleEvidencePath(plan.id));
        const lifecycle: unknown = JSON.parse(await readFile(lifecyclePath, 'utf8'));
        const finalLaunchId = caseLifecycleReceiptSchema.parse(lifecycle).launches.at(-1)?.id;
        if (!finalLaunchId) throw new Error(`Case ${plan.id} lifecycle has no launch`);
        evidenceBinding = { launchId: finalLaunchId };
    }
    await validateMobileEvidence({
        caseId: plan.id,
        device: expectedDevice,
        directory,
        evidenceBinding,
        evidencePaths: acceptanceCase.evidence.map(evidencePath),
        expectedStatus: ({ blocked: 'blocked', fail: 'failed', pass: 'passed' } as const)[
            acceptanceCase.status
        ],
        reportCommit,
    });
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
    const reportCommit = z
        .object({ commit: z.string().trim().min(1).optional() })
        .parse(rawReport).commit;
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
    assertUniqueAcceptanceCaseIds(report.plan, 'plan');
    assertUniqueAcceptanceCaseIds(report.cases, 'case');

    const planIds = report.plan.map(({ id }) => id);
    const caseIds = report.cases.map(({ id }) => id);
    if (planIds.length !== caseIds.length || planIds.some((id, index) => id !== caseIds[index])) {
        throw new Error('Case ids and order must exactly match the frozen plan');
    }

    for (const [index, item] of report.cases.entries()) {
        const planned = report.plan[index];
        if (
            item.name !== planned.title ||
            item.category !== planned.category ||
            item.surface !== planned.surface
        ) {
            throw new Error(
                `Case ${item.id} title, category, and surface must match the frozen plan`,
            );
        }
        const actualTypes = new Set<string>();
        for (const evidence of item.evidence) {
            // Sequential await preserves deterministic, index-ordered failure reporting when
            // multiple evidence entries are invalid; Promise.all would report whichever
            // filesystem check settles first instead of the first evidence entry in plan order.
            // eslint-disable-next-line no-await-in-loop
            actualTypes.add(await validateEvidenceFile(directory, evidencePath(evidence)));
        }
        /**
         * `requiredEvidence` names the medium that would show the planned behavior, so it only applies to a case that
         * reached a verdict about that behavior. A `blocked` case is the one that could not, and the schema's `min(1)`
         * plus the per-file check above still keep it from declaring nothing; demanding the unreachable medium would
         * leave "could not observe this" with no representable outcome.
         */
        const missing =
            item.status === 'blocked'
                ? []
                : requiredEvidenceTypes(planned).filter((required) => !actualTypes.has(required));
        if (missing.length > 0) {
            throw new Error(`Case ${item.id} is missing required evidence: ${missing.join(', ')}`);
        }
        /**
         * The medium is waived for `blocked`, so without this the schema's `min(1)` could be met by an
         * adapter-generated receipt alone. Those files record that the machinery ran; they say nothing about the
         * behavior. A blocked case must still show why it could not observe it — the covering test's result, a log
         * excerpt, the extracted copy.
         */
        if (
            item.status === 'blocked' &&
            item.evidence.every((evidence) => isLifecycleReceipt(evidencePath(evidence)))
        ) {
            throw new Error(
                `Case ${item.id} is blocked and must cite evidence beyond its lifecycle receipts`,
            );
        }
        // Sequential await preserves deterministic, plan-ordered failure reporting across cases;
        // see the evidence-file validation loop above for the same rationale.
        // eslint-disable-next-line no-await-in-loop
        await validateFixturePreflightEvidence(directory, planned, item);
        // eslint-disable-next-line no-await-in-loop
        await validateAgentFixtureEvidence(directory, {
            caseId: planned.id,
            evidencePaths: item.evidence.map(evidencePath),
            fixtureId: planned.agentFixture,
            status: item.status,
        });
        // eslint-disable-next-line no-await-in-loop
        await validateCaseLifecycleEvidence(directory, planned, item);
        // eslint-disable-next-line no-await-in-loop
        await validateMobileDeviceEvidence(directory, planned, item, reportCommit);
    }

    await validateReportMediaEvidence({
        cases: report.cases,
        directory,
        plans: report.plan,
    });

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
        ...report.summary,
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

function option(options: Options, key: string, isRequired = false): string | undefined {
    const value = options[key];
    if (isRequired && (typeof value !== 'string' || value.length === 0)) {
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

async function main(argv: string[]): Promise<void> {
    const [command, ...tokens] = argv;
    if (!command || command === 'help' || command === '--help' || tokens.includes('--help')) {
        console.log(reportCliHelp());
        return;
    }
    if (
        command !== 'init' &&
        command !== 'rebind-head' &&
        command !== 'repair-lifecycle' &&
        command !== 'finalize'
    ) {
        throw new Error(`Unknown command: ${command}`);
    }
    const options = parseOptions(tokens);
    const directory = option(options, 'dir', true);
    if (!directory) throw new Error('Missing report directory');

    if (command === 'repair-lifecycle') {
        const caseId = option(options, 'case-id', true);
        const reason = option(options, 'reason', true);
        if (!caseId || !reason) throw new Error('Missing lifecycle repair input');
        const result = await repairCaseLifecycle(directory, { caseId, reason });
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (command === 'rebind-head') {
        const commit = option(options, 'commit', true);
        const entry = option(options, 'entry', true);
        const fromCommit = option(options, 'from-commit', true);
        const reason = option(options, 'reason', true);
        if (!commit || !entry || !fromCommit || !reason) {
            throw new Error('Missing report head rebind input');
        }
        await rebindReportHead({
            allowFinalized: options['allow-finalized'] === true,
            changedPaths: await changedPathsBetween(fromCommit, commit),
            commit,
            createdAt: option(options, 'created-at'),
            directory,
            entry,
            fromCommit,
            reason,
        });
        console.log(join(resolve(PROJECT_ROOT, directory), 'result.json'));
        return;
    }

    const requirement = option(options, 'requirement', true);
    if (!requirement) throw new Error('Missing report requirement');

    if (command === 'init') {
        const planPath = option(options, 'plan', true);
        const title = option(options, 'title', true);
        const entry = option(options, 'entry', true);
        if (!planPath || !title || !entry) throw new Error('Missing report scaffold input');
        const pullRequestRaw = option(options, 'pull-request');
        const pullRequest = pullRequestRaw === undefined ? undefined : Number(pullRequestRaw);
        if (pullRequest !== undefined && (!Number.isSafeInteger(pullRequest) || pullRequest <= 0)) {
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
    // `command` can only be 'finalize' here: 'help'/'--help' returned above, and 'init',
    // 'rebind-head', and 'repair-lifecycle' were each handled (and returned) by the branches above.
    const report = await finalizeReport({
        conclusion: option(options, 'conclusion'),
        directory,
        requirement,
    });
    console.log(JSON.stringify(report.summary, null, 2));
}

const SCRIPT_PATH = resolve(fileURLToPath(import.meta.url));
const invokedPath =
    process.argv[1] && (isAbsolute(process.argv[1]) ? process.argv[1] : resolve(process.argv[1]));
if (invokedPath === SCRIPT_PATH) {
    try {
        await main(process.argv.slice(2));
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
