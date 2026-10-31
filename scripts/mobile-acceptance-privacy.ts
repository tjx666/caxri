#!/usr/bin/env bun

import type { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    markCaseLifecycleReady,
} from '../.agents/skills/acceptance/scripts/case-lifecycle';
import { loadAcceptanceCasePlan } from '../.agents/skills/acceptance/scripts/report-case-plan';
import {
    assertMobileAcceptanceSourceIdentity,
    clearMobileAcceptanceCaseArtifacts,
    runMobileAcceptanceCommand,
    writeMobileAcceptanceReceipt,
} from './mobile-acceptance-runtime';

const CASE_ID = 'MOB-PAIR-04';
const projectRoot = resolve(import.meta.dirname, '..');
const visualInspector = join(import.meta.dirname, 'mobile-acceptance-privacy.swift');
const SOURCE_TIMEOUT_MS = 10_000;
const VISUAL_TIMEOUT_MS = 10 * 60_000;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.htm', '.html', '.json', '.md', '.svg', '.txt', '.xml']);
const IMAGE_EXTENSIONS = new Set(['.bmp', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.gif', '.m4v', '.mov', '.mp4', '.webm']);

interface EvidenceManifestEntry {
    bytes: number;
    path: string;
    sha256: string;
}

interface VisualInspection {
    barcodeCount: number;
    credentialTextKinds: string[];
}

const credentialPatterns = [
    { kind: 'pairing-uri', pattern: /caxri\s*:\s*\/\/\s*pair/iu },
    {
        kind: 'pairing-secret',
        pattern: /\b(?:pairing\s*secret|secret|psk)\s*[:=]/iu,
    },
    {
        kind: 'device-credential',
        pattern: /\b(?:device\s*credential|credential)\s*[:=]/iu,
    },
    {
        kind: 'private-key',
        pattern: /-----BEGIN (?:PRIVATE|RSA PRIVATE|EC PRIVATE) KEY-----/iu,
    },
    { kind: 'bearer-token', pattern: /\bbearer\s+[\w.~+/-]{12,}/iu },
] as const;

// eslint-disable-next-line unicorn/no-exports-in-scripts -- focused tests exercise the privacy classifier.
export function credentialKindsInText(source: string): string[] {
    return credentialPatterns.filter(({ pattern }) => pattern.test(source)).map(({ kind }) => kind);
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- focused tests exercise deterministic manifest binding.
export function evidenceManifestSha256(entries: readonly EvidenceManifestEntry[]): string {
    const canonical = [...entries].toSorted((left, right) => left.path.localeCompare(right.path));
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function sha256(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
    return hash.digest('hex');
}

async function evidenceFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    const visit = async (current: string): Promise<void> => {
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const path = join(current, entry.name);
            if (entry.isSymbolicLink()) throw new Error('Acceptance evidence cannot be a symlink');
            if (entry.isDirectory()) {
                // Sequential traversal preserves deterministic evidence order and avoids unbounded file handles.
                // eslint-disable-next-line no-await-in-loop
                await visit(path);
            } else if (entry.isFile()) {
                files.push(path);
            }
        }
    };
    await visit(directory);
    return files
        .filter((path) => !basename(path).startsWith(`${CASE_ID}-`))
        .toSorted((left, right) => left.localeCompare(right));
}

async function inspectImage(path: string): Promise<VisualInspection> {
    const { stdout } = await execFileAsync('swift', [visualInspector, path], {
        maxBuffer: 1024 * 1024,
        timeout: VISUAL_TIMEOUT_MS,
    });
    const result = JSON.parse(String(stdout)) as Partial<VisualInspection>;
    if (!Number.isSafeInteger(result.barcodeCount) || !Array.isArray(result.credentialTextKinds)) {
        throw new TypeError('Visual privacy inspector returned an invalid receipt');
    }
    return result as VisualInspection;
}

async function inspectVisual(path: string): Promise<{ frames: number; violations: string[] }> {
    const extension = extname(path).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) {
        const result = await inspectImage(path);
        return {
            frames: 1,
            violations: [
                ...(result.barcodeCount > 0 ? ['barcode'] : []),
                ...result.credentialTextKinds,
            ],
        };
    }
    if (!VIDEO_EXTENSIONS.has(extension)) return { frames: 0, violations: [] };

    const framesDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-privacy-'));
    try {
        await execFileAsync(
            'ffmpeg',
            ['-v', 'error', '-i', path, '-vf', 'fps=2', join(framesDirectory, 'frame-%06d.png')],
            { timeout: VISUAL_TIMEOUT_MS },
        );
        const frames = (await readdir(framesDirectory))
            .filter((entry) => entry.endsWith('.png'))
            .toSorted((left, right) => left.localeCompare(right));
        if (frames.length === 0) throw new Error('Video privacy inspection produced no frames');
        const violations = new Set<string>();
        for (const frame of frames) {
            // Sequential Vision requests bound native memory while scanning every sampled frame.
            // eslint-disable-next-line no-await-in-loop
            const result = await inspectImage(join(framesDirectory, frame));
            if (result.barcodeCount > 0) violations.add('barcode');
            for (const kind of result.credentialTextKinds) violations.add(kind);
        }
        return {
            frames: frames.length,
            violations: [...violations].toSorted((left, right) => left.localeCompare(right)),
        };
    } finally {
        await rm(framesDirectory, { force: true, recursive: true });
    }
}

async function main(): Promise<void> {
    const reportIndex = process.argv.indexOf('--report-dir');
    const reportDirectory = process.argv[reportIndex + 1];
    if (reportIndex === -1 || !reportDirectory) throw new Error('--report-dir is required');
    const planned = await loadAcceptanceCasePlan(reportDirectory, CASE_ID);
    if (planned.item.surface !== 'desktop' || planned.item.stateIsolation.mode !== 'isolated') {
        throw new Error('Evidence privacy Acceptance requires an isolated desktop program item');
    }
    const sourceCommit = runMobileAcceptanceCommand({
        arguments: ['rev-parse', 'HEAD'],
        captureOutput: true,
        command: 'git',
        cwd: projectRoot,
        deadlineMs: Date.now() + SOURCE_TIMEOUT_MS,
        timeoutMs: SOURCE_TIMEOUT_MS,
    })
        .trim()
        .toLowerCase();
    const sourceStatus = runMobileAcceptanceCommand({
        arguments: ['status', '--porcelain', '--untracked-files=normal'],
        captureOutput: true,
        command: 'git',
        cwd: projectRoot,
        deadlineMs: Date.now() + SOURCE_TIMEOUT_MS,
        timeoutMs: SOURCE_TIMEOUT_MS,
    });
    assertMobileAcceptanceSourceIdentity({
        actualCommit: sourceCommit,
        plannedCommit: planned.commit,
        status: sourceStatus,
    });

    await clearMobileAcceptanceCaseArtifacts(reportDirectory, CASE_ID);
    const launchId = await beginCaseLifecycle(reportDirectory, {
        caseId: CASE_ID,
        profileIdentity: `privacy-scan:${randomUUID()}`,
        stateIsolation: planned.item.stateIsolation,
    });
    let failure: unknown;
    try {
        await markCaseLifecycleReady(reportDirectory, { caseId: CASE_ID, launchId });
        const assetsDirectory = join(reportDirectory, 'assets');
        const files = await evidenceFiles(assetsDirectory);
        if (files.length === 0) throw new Error('Evidence privacy scan found no artifacts');
        const manifest: EvidenceManifestEntry[] = [];
        let inspectedFrames = 0;
        for (const path of files) {
            // Sequential reads and native inspection keep the scanner bounded for video-heavy rounds.
            // eslint-disable-next-line no-await-in-loop
            const metadata = await lstat(path);
            const reportPath = `assets/${relative(assetsDirectory, path).replaceAll('\\', '/')}`;
            manifest.push({
                bytes: metadata.size,
                path: reportPath,
                // eslint-disable-next-line no-await-in-loop -- manifest order is deterministic.
                sha256: await sha256(path),
            });
            if (TEXT_EXTENSIONS.has(extname(path).toLowerCase())) {
                if (metadata.size > MAX_TEXT_BYTES) {
                    throw new Error(`Text evidence exceeds the privacy scan limit: ${reportPath}`);
                }
                // eslint-disable-next-line no-await-in-loop -- each artifact is independently bounded.
                const kinds = credentialKindsInText(await readFile(path, 'utf8'));
                if (kinds.length > 0) {
                    throw new Error(
                        `Evidence privacy violation in ${reportPath}: ${kinds.join(', ')}`,
                    );
                }
            }
            // eslint-disable-next-line no-await-in-loop -- native visual inspection is intentionally serialized.
            const visual = await inspectVisual(path);
            inspectedFrames += visual.frames;
            if (visual.violations.length > 0) {
                throw new Error(
                    `Evidence visual privacy violation in ${reportPath}: ${visual.violations.join(', ')}`,
                );
            }
        }
        for (const metadataPath of [
            join(reportDirectory, 'result.json'),
            join(reportDirectory, 'report.md'),
        ]) {
            // Sequential metadata reads ensure the final report text is covered without binding mutable case bookkeeping.
            // eslint-disable-next-line no-await-in-loop
            const kinds = credentialKindsInText(await readFile(metadataPath, 'utf8'));
            if (kinds.length > 0) {
                throw new Error(
                    `Acceptance report metadata failed the privacy scan: ${kinds.join(', ')}`,
                );
            }
        }
        await writeMobileAcceptanceReceipt(join(assetsDirectory, `${CASE_ID}-privacy.txt`), {
            artifactCount: manifest.length,
            caseId: CASE_ID,
            inspectedFrameCount: inspectedFrames,
            manifestSha256: evidenceManifestSha256(manifest),
            policy: 'no-pairing-uri-secret-credential-key-token-or-barcode',
            schemaVersion: 1,
            sourceCommit,
            status: 'passed',
            visualReview: 'program-scan-complete-human-review-required-before-publication',
        });
    } catch (error) {
        failure = error;
    } finally {
        try {
            await completeCaseLifecycle(reportDirectory, {
                caseId: CASE_ID,
                cleanupCompleted: true,
                cleanupRequested: true,
                launchId,
            });
        } catch (error) {
            failure ??= error;
        }
    }
    if (failure)
        throw failure instanceof Error ? failure : new Error('Evidence privacy scan failed');
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
