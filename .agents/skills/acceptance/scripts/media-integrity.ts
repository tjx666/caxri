import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { execFileAsync } from '@caxri/system';

const MINIMUM_VIDEO_DURATION_SECONDS = 3;
const MINIMUM_VIDEO_FRAMES = 12;
const MINIMUM_SAMPLED_FRAMES = 6;
const MINIMUM_DISTINCT_SAMPLED_FRAMES = 3;
const MAXIMUM_VIDEO_DURATION_SECONDS = 120;
const MAXIMUM_ANDROID_JOURNEY_DURATION_SECONDS = 180;
const MAXIMUM_STATIC_DESKTOP_DURATION_SECONDS = 180;
const FFPROBE_TIMEOUT_MS = 10_000;
const FFMPEG_TIMEOUT_MS = 30_000;
const VIDEO_EXTENSIONS = new Set(['.m4v', '.mov', '.mp4', '.webm']);
const MEDIA_EXTENSIONS = new Set([
    ...VIDEO_EXTENSIONS,
    '.bmp',
    '.gif',
    '.htm',
    '.html',
    '.jpeg',
    '.jpg',
    '.png',
    '.svg',
    '.webp',
]);

export type MediaCommandRunner = (command: string, arguments_: string[]) => Promise<string>;

interface AcceptanceMediaCase {
    evidence: Array<string | { path: string }>;
    id: string;
    status: 'blocked' | 'fail' | 'pass';
}

interface AcceptanceMediaPlan {
    id: string;
    requiredEvidence: Array<string | { type: string }>;
}

interface PreviousRoundCase {
    evidence: Array<string | { path: string }>;
    id: string;
    status: string;
}

interface VideoProbe {
    format?: { duration?: string };
    streams?: Array<{ avg_frame_rate?: string; nb_frames?: string }>;
}

interface MediaHashSource {
    caseId: string;
    hash: string;
    roundName?: string;
}

export interface VideoEvidenceIntegrity {
    distinctSampledFrames: number;
    durationSeconds: number;
    frameCount: number;
    sampledFrameCount: number;
}

const defaultRunner: MediaCommandRunner = async (command, arguments_) => {
    const { stdout } = await execFileAsync(command, arguments_, {
        maxBuffer: 32 * 1024 * 1024,
        timeout: command === 'ffprobe' ? FFPROBE_TIMEOUT_MS : FFMPEG_TIMEOUT_MS,
    });
    return String(stdout);
};

function evidencePath(evidence: string | { path: string }): string {
    return typeof evidence === 'string' ? evidence : evidence.path;
}

function isMediaEvidence(path: string): boolean {
    return MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
}

function isVideoEvidence(path: string): boolean {
    return VIDEO_EXTENSIONS.has(extname(path).toLowerCase());
}

function finitePositiveNumber(value: string | undefined): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseFrameRate(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const [numerator, denominator = '1'] = value.split('/', 2);
    const parsedNumerator = Number(numerator);
    const parsedDenominator = Number(denominator);
    if (
        !Number.isFinite(parsedNumerator) ||
        !Number.isFinite(parsedDenominator) ||
        parsedNumerator <= 0 ||
        parsedDenominator <= 0
    ) {
        return undefined;
    }
    return parsedNumerator / parsedDenominator;
}

function parseSampledFrameHashes(output: string): string[] {
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => line.split(',').at(-1)?.trim())
        .filter((hash): hash is string => Boolean(hash));
}

/**
 * Rejects placeholder recordings before an Acceptance report can call them temporal proof. Sampling at two frames per
 * second after downscaling catches static or near-static captures without requiring identical source dimensions.
 */
export async function validateVideoEvidence(
    filePath: string,
    runner: MediaCommandRunner = defaultRunner,
    options: { allowLongAndroidJourney?: boolean; allowStaticDesktop?: boolean } = {},
): Promise<VideoEvidenceIntegrity> {
    const probeOutput = await runner('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'format=duration:stream=avg_frame_rate,nb_frames',
        '-of',
        'json',
        filePath,
    ]);
    const probe = JSON.parse(probeOutput) as VideoProbe;
    const durationSeconds = finitePositiveNumber(probe.format?.duration);
    if (!durationSeconds || durationSeconds < MINIMUM_VIDEO_DURATION_SECONDS) {
        throw new Error(
            `Video evidence ${filePath} must be at least ${MINIMUM_VIDEO_DURATION_SECONDS} seconds`,
        );
    }
    const maxDurationSeconds = options.allowStaticDesktop
        ? MAXIMUM_STATIC_DESKTOP_DURATION_SECONDS
        : options.allowLongAndroidJourney
          ? MAXIMUM_ANDROID_JOURNEY_DURATION_SECONDS
          : MAXIMUM_VIDEO_DURATION_SECONDS;
    if (durationSeconds > maxDurationSeconds) {
        throw new Error(`Video evidence ${filePath} must be at most ${maxDurationSeconds} seconds`);
    }

    const stream = probe.streams?.[0];
    const explicitFrameCount = finitePositiveNumber(stream?.nb_frames);
    const frameRate = parseFrameRate(stream?.avg_frame_rate);
    const frameCount = Math.round(explicitFrameCount ?? durationSeconds * (frameRate ?? 0));
    if (frameCount < MINIMUM_VIDEO_FRAMES) {
        throw new Error(
            `Video evidence ${filePath} must contain at least ${MINIMUM_VIDEO_FRAMES} frames`,
        );
    }

    const frameHashOutput = await runner('ffmpeg', [
        '-v',
        'error',
        '-i',
        filePath,
        '-vf',
        'fps=2,scale=32:18:flags=area,format=gray',
        '-map',
        '0:v:0',
        '-t',
        String(maxDurationSeconds),
        '-frames:v',
        String(maxDurationSeconds * 2),
        '-f',
        'framemd5',
        '-',
    ]);
    const sampledHashes = parseSampledFrameHashes(frameHashOutput);
    if (sampledHashes.length < MINIMUM_SAMPLED_FRAMES) {
        throw new Error(
            `Video evidence ${filePath} must contain at least ${MINIMUM_SAMPLED_FRAMES} sampled frames`,
        );
    }
    const distinctSampledFrames = new Set(sampledHashes).size;
    if (!options.allowStaticDesktop && distinctSampledFrames < MINIMUM_DISTINCT_SAMPLED_FRAMES) {
        throw new Error(
            `Video evidence ${filePath} must contain at least ${MINIMUM_DISTINCT_SAMPLED_FRAMES} distinct sampled frames`,
        );
    }

    return {
        distinctSampledFrames,
        durationSeconds,
        frameCount,
        sampledFrameCount: sampledHashes.length,
    };
}

async function sha256(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
    return hash.digest('hex');
}

function roundNumber(directoryName: string): number | undefined {
    const match = /^round-(\d+)$/.exec(directoryName);
    if (!match) return undefined;
    return Number(match[1]);
}

async function resolveMediaPath(directory: string, evidence: string): Promise<string> {
    if (isAbsolute(evidence)) throw new Error(`Evidence path must be relative: ${evidence}`);
    const normalized = evidence.replaceAll('\\', '/');
    if (!normalized.startsWith('assets/')) {
        throw new Error(`Evidence path must stay under assets/: ${evidence}`);
    }
    const [canonicalAssets, canonicalEvidence] = await Promise.all([
        realpath(resolve(directory, 'assets')),
        realpath(resolve(directory, normalized)),
    ]);
    const relativePath = relative(canonicalAssets, canonicalEvidence);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error(`Evidence path must stay under assets/: ${evidence}`);
    }
    const metadata = await lstat(canonicalEvidence);
    if (!metadata.isFile()) throw new Error(`Evidence path is not a file: ${evidence}`);
    return canonicalEvidence;
}

function parsePreviousRoundCases(raw: string, roundName: string): PreviousRoundCase[] {
    const parsed: unknown = JSON.parse(raw);
    if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('cases' in parsed) ||
        !Array.isArray(parsed.cases)
    ) {
        throw new Error(`Acceptance ${roundName} result is missing cases`);
    }
    const rawCases: unknown[] = parsed.cases;
    return rawCases.filter((item): item is PreviousRoundCase => {
        if (!item || typeof item !== 'object') return false;
        return (
            'id' in item &&
            typeof item.id === 'string' &&
            'status' in item &&
            typeof item.status === 'string' &&
            'evidence' in item &&
            Array.isArray(item.evidence)
        );
    });
}

async function nonPassingPriorMediaHashes(
    directory: string,
): Promise<Map<string, MediaHashSource>> {
    const currentRoundNumber = roundNumber(directory.split('/').at(-1) ?? '');
    if (currentRoundNumber === undefined) return new Map();
    const parent = resolve(directory, '..');
    const entries = await readdir(parent, { withFileTypes: true });
    const previousRounds = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, number: roundNumber(entry.name) }))
        .filter(
            (entry): entry is { name: string; number: number } =>
                entry.number !== undefined && entry.number < currentRoundNumber,
        )
        .toSorted((left, right) => left.number - right.number);
    const sourcesByHash = new Map<string, MediaHashSource>();

    for (const previousRound of previousRounds) {
        const previousDirectory = join(parent, previousRound.name);
        // Sequential reads keep immutable round lineage and errors deterministic.
        // eslint-disable-next-line no-await-in-loop
        const rawResult = await readFile(join(previousDirectory, 'result.json'), 'utf8');
        const cases = parsePreviousRoundCases(rawResult, previousRound.name);
        for (const acceptanceCase of cases) {
            if (acceptanceCase.status !== 'pass') {
                for (const evidence of acceptanceCase.evidence) {
                    const path = evidencePath(evidence);
                    if (isMediaEvidence(path)) {
                        // Sequential canonicalization keeps malformed history failures deterministic.
                        // eslint-disable-next-line no-await-in-loop
                        const resolvedPath = await resolveMediaPath(previousDirectory, path);
                        // Sequential hashing avoids reading several large recordings into memory at once.
                        // eslint-disable-next-line no-await-in-loop
                        const hash = await sha256(resolvedPath);
                        sourcesByHash.set(hash, {
                            caseId: acceptanceCase.id,
                            hash,
                            roundName: previousRound.name,
                        });
                    }
                }
            }
        }
    }
    return sourcesByHash;
}

async function currentNonPassingMediaHashes(
    cases: AcceptanceMediaCase[],
    directory: string,
): Promise<Map<string, MediaHashSource>> {
    const sourcesByHash = new Map<string, MediaHashSource>();
    for (const acceptanceCase of cases) {
        if (acceptanceCase.status !== 'pass') {
            for (const evidence of acceptanceCase.evidence) {
                const path = evidencePath(evidence);
                if (isMediaEvidence(path)) {
                    // Sequential canonicalization and hashing bound large-media filesystem pressure.
                    // eslint-disable-next-line no-await-in-loop
                    const resolvedPath = await resolveMediaPath(directory, path);
                    // eslint-disable-next-line no-await-in-loop
                    const hash = await sha256(resolvedPath);
                    sourcesByHash.set(hash, { caseId: acceptanceCase.id, hash });
                }
            }
        }
    }
    return sourcesByHash;
}

async function validateCurrentCaseMedia(input: {
    acceptanceCase: AcceptanceMediaCase;
    currentNonPassingByHash: Map<string, MediaHashSource>;
    currentVideoOwner: Map<string, string>;
    directory: string;
    priorNonPassingByHash: Map<string, MediaHashSource>;
    runner?: MediaCommandRunner;
    longAndroidVideos: Set<string>;
    staticDesktopVideos: Map<string, number>;
}): Promise<void> {
    for (const evidence of input.acceptanceCase.evidence) {
        const path = evidencePath(evidence);
        if (isMediaEvidence(path)) {
            // Sequential canonicalization keeps evidence failures in report order.
            // eslint-disable-next-line no-await-in-loop
            const resolvedPath = await resolveMediaPath(input.directory, path);
            if (isVideoEvidence(path)) {
                // Sequential probing avoids running several ffmpeg decoders during report finalization.

                const declaredDurationMs = input.staticDesktopVideos.get(path);
                // eslint-disable-next-line no-await-in-loop
                const integrity = await validateVideoEvidence(resolvedPath, input.runner, {
                    allowLongAndroidJourney: input.longAndroidVideos.has(path),
                    allowStaticDesktop: declaredDurationMs !== undefined,
                });
                if (
                    declaredDurationMs !== undefined &&
                    Math.abs(integrity.durationSeconds * 1_000 - declaredDurationMs) > 750
                ) {
                    throw new Error(
                        `Desktop video evidence ${path} duration does not match its receipt`,
                    );
                }
            }
            if (input.acceptanceCase.status === 'pass') {
                // Sequential hashing avoids reading several large recordings into memory at once.
                // eslint-disable-next-line no-await-in-loop
                const hash = await sha256(resolvedPath);
                const currentReused = input.currentNonPassingByHash.get(hash);
                if (currentReused) {
                    throw new Error(
                        `Case ${input.acceptanceCase.id} reuses media from non-passing case ${currentReused.caseId} in the current round`,
                    );
                }
                const priorReused = input.priorNonPassingByHash.get(hash);
                if (priorReused) {
                    throw new Error(
                        `Case ${input.acceptanceCase.id} reuses media from ${priorReused.caseId} in non-passing ${priorReused.roundName}`,
                    );
                }
                if (isVideoEvidence(path)) {
                    const existingOwner = input.currentVideoOwner.get(hash);
                    if (existingOwner && existingOwner !== input.acceptanceCase.id) {
                        throw new Error(
                            `Case ${input.acceptanceCase.id} duplicates video evidence across cases ${existingOwner} and ${input.acceptanceCase.id}`,
                        );
                    }
                    input.currentVideoOwner.set(hash, input.acceptanceCase.id);
                }
            }
        }
    }
}

/**
 * Validates current-round temporal media and prevents a previously non-passing artifact from being relabeled as pass.
 * Passing cases also own distinct video bytes so one generic recording cannot stand in for unrelated interactions.
 */
export async function validateReportMediaEvidence(input: {
    cases: AcceptanceMediaCase[];
    directory: string;
    plans: AcceptanceMediaPlan[];
    runner?: MediaCommandRunner;
    longAndroidVideos?: Set<string>;
    staticDesktopVideos?: Map<string, number>;
}): Promise<void> {
    const planIds = new Set(input.plans.map(({ id }) => id));
    const [currentNonPassingByHash, priorNonPassingByHash] = await Promise.all([
        currentNonPassingMediaHashes(input.cases, input.directory),
        nonPassingPriorMediaHashes(input.directory),
    ]);
    const currentVideoOwner = new Map<string, string>();

    for (const acceptanceCase of input.cases) {
        if (!planIds.has(acceptanceCase.id)) {
            throw new Error(
                `Acceptance case ${acceptanceCase.id} is not present in the frozen plan`,
            );
        }
        // Sequential validation bounds ffmpeg and hashing load for large desktop recordings.
        // eslint-disable-next-line no-await-in-loop
        await validateCurrentCaseMedia({
            acceptanceCase,
            currentNonPassingByHash,
            currentVideoOwner,
            directory: input.directory,
            priorNonPassingByHash,
            runner: input.runner,
            longAndroidVideos: input.longAndroidVideos ?? new Set<string>(),
            staticDesktopVideos: input.staticDesktopVideos ?? new Map<string, number>(),
        });
    }
}
