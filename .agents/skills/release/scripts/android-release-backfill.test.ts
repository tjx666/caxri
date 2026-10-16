import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { BackfillCommand } from './android-release-backfill';
import { publishAndroidBackfill, resolveAndroidBackfill, stageAndroidBackfill, verifyAndroidBackfill } from './android-release-backfill';

const tag = 'v0.0.104';
const sha = 'a'.repeat(40);
const repo = 'owner/project';
const name = 'Caxri-Mobile-0.0.104-android-arm64.apk';
const release = {
    id: 123,
    tag_name: tag,
    draft: false,
    published_at: '2026-01-01T00:00:00Z',
    body: 'Existing desktop installation notes',
    assets: [{ name: 'Caxri-0.0.104-arm64.dmg' }],
};
const verifiedHash = createHash('sha256').update('synthetic Android APK').digest('hex');
const paths: string[] = [];

afterEach(async () => {
    const currentPaths = [...paths];
    paths.length = 0;
    await Promise.all(currentPaths.map(async (path) => rm(path, { recursive: true, force: true })));
});

function commands(overrides: Partial<Record<string, string>> = {}) {
    const run = vi.fn<BackfillCommand>(async (command, arguments_) => {
        const key = `${command} ${arguments_.join(' ')}`;
        const responses: Partial<Record<string, string>> = {
            [`gh api repos/${repo}/releases/tags/${tag}`]: JSON.stringify(release),
            [`gh api repos/${repo}/commits/${tag} --jq .sha`]: sha,
            [`git rev-parse --verify refs/tags/${tag}^0`]: sha,
            'git rev-parse HEAD': sha,
            [`git merge-base --is-ancestor ${sha} HEAD`]: '',
            [`git show -s --format=%s ${sha}`]: `release: ${tag}`,
            [`git show ${sha}:package.json`]: JSON.stringify({ version: '0.0.104' }),
            ...overrides,
        };
        const response = responses[key];
        if (typeof response === 'string') return response;
        if (command === 'gh' && arguments_[0] === 'release') return '';
        throw new Error(`Unexpected command: ${key}`);
    });
    return run;
}

async function bundle(overrides: Record<string, unknown> = {}) {
    const cwd = await mkdtemp(join(tmpdir(), 'caxri-android-backfill-'));
    paths.push(cwd);
    await mkdir(join(cwd, 'out/mobile-update'), { recursive: true });
    const apk = 'synthetic Android APK';
    await writeFile(join(cwd, 'out/mobile-update/caxri-mobile.apk'), apk);
    await writeFile(join(cwd, 'out/mobile-update/manifest.json'), JSON.stringify({
        version: '0.0.104', versionCode: 104, sizeBytes: apk.length,
        md5: createHash('md5').update(apk).digest('hex'), ...overrides,
    }));
    return cwd;
}

describe('existing-release Android backfill', () => {
    it('pins an existing published release commit with a matching subject and package version', async () => {
        const run = commands();
        await expect(resolveAndroidBackfill(repo, tag, run)).resolves.toEqual({ tag, sha, releaseId: 123 });
        expect(run).toHaveBeenCalledWith('git', ['merge-base', '--is-ancestor', sha, 'HEAD']);
    });

    it.each(['main', 'v1.2', 'v01.2.3', 'v1.2.3-beta.1', 'v1.2.3;false'])('rejects non-stable or arbitrary refs: %s', async (reference) => {
        const run = commands();
        await expect(resolveAndroidBackfill(repo, reference, run)).rejects.toThrow('exact stable release tag');
        expect(run).not.toHaveBeenCalled();
    });

    it.each([
        { ...release, draft: true },
        { ...release, published_at: null },
        { ...release, assets: [] },
    ])('rejects unpublished or incomplete releases', async (value) => {
        const run = commands({
            [`gh api repos/${repo}/releases/tags/${tag}`]: JSON.stringify(value),
        });
        await expect(resolveAndroidBackfill(repo, tag, run)).rejects.toThrow();
    });

    it.each([
        { [`git show -s --format=%s ${sha}`]: 'ordinary source commit' },
        { [`git show ${sha}:package.json`]: JSON.stringify({ version: '0.0.105' }) },
        { [`git rev-parse --verify refs/tags/${tag}^0`]: 'unresolved' },
    ])('rejects an invalid release source', async (overrides) => {
        await expect(resolveAndroidBackfill(repo, tag, commands(overrides))).rejects.toThrow();
    });

    it('refuses a tag whose commit is outside trusted main history', async () => {
        const run = commands();
        const execute: BackfillCommand = async (command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'merge-base') throw new Error('not an ancestor');
            return run(command, arguments_);
        };
        await expect(resolveAndroidBackfill(repo, tag, execute)).rejects.toThrow('not an ancestor');
    });

    it.each([{ version: '0.0.105' }, { versionCode: 105 }, { sizeBytes: 1 }, { md5: 'mismatch' }])('refuses a stale or corrupt staged bundle', async (overrides) => {
        await expect(stageAndroidBackfill(await bundle(overrides), tag)).rejects.toThrow('integrity');
    });

    it.each([
        { [`gh api repos/${repo}/commits/${tag} --jq .sha`]: 'b'.repeat(40) },
        { 'git rev-parse HEAD': 'b'.repeat(40) },
        { [`gh api repos/${repo}/releases/tags/${tag}`]: JSON.stringify({ ...release, id: 124 }) },
    ])('refuses publication if tag, checkout or Release identity changes', async (overrides) => {
        const run = commands(overrides);
        await expect(publishAndroidBackfill(await bundle(), repo, { tag, sha, releaseId: 123 }, run, verifiedHash)).rejects.toThrow('identity changed');
        expect(run.mock.calls.some(([, arguments_]) => arguments_[0] === 'release')).toBe(false);
    });

    it('uploads exact bundle bytes and a portable checksum, preserving the existing release notes', async () => {
        const cwd = await bundle();
        const run = commands();
        let notes = '';
        run.mockImplementationOnce(async () => JSON.stringify(release));
        const execute: BackfillCommand = async (command, arguments_) => {
            if (command === 'gh' && arguments_[1] === 'edit') {
                notes = await readFile(arguments_.at(-1)!, 'utf8');
            }
            return run(command, arguments_);
        };
        await publishAndroidBackfill(cwd, repo, { tag, sha, releaseId: 123 }, execute, verifiedHash);
        const apk = join(cwd, 'release.noindex/mobile', name);
        expect(await readFile(apk, 'utf8')).toBe('synthetic Android APK');
        expect(await readFile(`${apk}.sha256`, 'utf8')).toBe(`${createHash('sha256').update('synthetic Android APK').digest('hex')}  ${name}\n`);
        expect(run).toHaveBeenCalledWith('gh', ['release', 'upload', tag, apk, '--repo', repo]);
        expect(run).toHaveBeenCalledWith('gh', ['release', 'upload', tag, `${apk}.sha256`, '--repo', repo]);
        expect(notes).toContain(release.body);
        expect(notes).toContain(sha);
        expect(notes).toContain('original DMGs are unchanged');
        expect(notes).toContain('Allow from this source');
    });

    it.each([[name], [`${name}.sha256`], [name, `${name}.sha256`]])('resumes exact existing assets: %j', async (...existingNames) => {
        const cwd = await bundle();
        const apk = await stageAndroidBackfill(cwd, tag);
        const metadata = { ...release, assets: [...release.assets, ...existingNames.map((entry) => ({ name: entry }))] };
        const run = commands({ [`gh api repos/${repo}/releases/tags/${tag}`]: JSON.stringify(metadata) });
        const execute: BackfillCommand = async (command, arguments_) => {
            if (command === 'gh' && arguments_[1] === 'download') {
                const name = arguments_[arguments_.indexOf('--pattern') + 1]!;
                await writeFile(join(arguments_.at(-1)!, name), await readFile(join(cwd, 'release.noindex/mobile', name)));
            }
            return run(command, arguments_);
        };
        await expect(resolveAndroidBackfill(repo, tag, run)).resolves.toEqual({ tag, sha, releaseId: 123 });
        await publishAndroidBackfill(cwd, repo, { tag, sha, releaseId: 123 }, execute, verifiedHash);
        const uploaded = run.mock.calls.filter(([, arguments_]) => arguments_[1] === 'upload').map(([, arguments_]) => basename(arguments_[3]!));
        expect(uploaded).toEqual([basename(apk), `${basename(apk)}.sha256`].filter((entry) => !existingNames.includes(entry)));
    });

    it.each([name, `${name}.sha256`])('refuses conflicting bytes before any upload: %s', async (conflict) => {
        const cwd = await bundle();
        const metadata = { ...release, assets: [...release.assets, { name }, { name: `${name}.sha256` }] };
        const run = commands({ [`gh api repos/${repo}/releases/tags/${tag}`]: JSON.stringify(metadata) });
        const execute: BackfillCommand = async (command, arguments_) => {
            if (command === 'gh' && arguments_[1] === 'download') {
                const asset = arguments_[arguments_.indexOf('--pattern') + 1]!;
                const bytes = asset === conflict ? 'conflicting published asset' : await readFile(join(cwd, 'release.noindex/mobile', asset));
                await writeFile(join(arguments_.at(-1)!, asset), bytes);
            }
            return run(command, arguments_);
        };
        await expect(publishAndroidBackfill(cwd, repo, { tag, sha, releaseId: 123 }, execute, verifiedHash)).rejects.toThrow('conflicts');
        expect(run.mock.calls.some(([, arguments_]) => arguments_[1] === 'upload' || arguments_[1] === 'edit')).toBe(false);
    });

    it('recovers a notes failure without uploading again or duplicating the Android section', async () => {
        const cwd = await bundle();
        const files = new Map<string, string>();
        const run = commands();
        let body = release.body;
        let shouldFailNotes = true;
        let uploads = 0;
        const execute: BackfillCommand = async (command, arguments_) => {
            if (command === 'gh' && arguments_[0] === 'api' && arguments_[1]?.includes('/releases/')) {
                return JSON.stringify({ ...release, body, assets: [...release.assets, ...files.keys().map((name) => ({ name }))] });
            }
            if (command === 'gh' && arguments_[1] === 'upload') {
                uploads += 1;
                files.set(basename(arguments_[3]!), await readFile(arguments_[3]!, 'utf8'));
                return '';
            }
            if (command === 'gh' && arguments_[1] === 'download') {
                const name = arguments_[arguments_.indexOf('--pattern') + 1]!;
                await writeFile(join(arguments_.at(-1)!, name), files.get(name)!);
                return '';
            }
            if (command === 'gh' && arguments_[1] === 'edit') {
                if (shouldFailNotes) {
                    shouldFailNotes = false;
                    throw new Error('transient notes failure');
                }
                body = await readFile(arguments_.at(-1)!, 'utf8');
                return '';
            }
            return run(command, arguments_);
        };
        const target = { tag, sha, releaseId: 123 };
        await expect(publishAndroidBackfill(cwd, repo, target, execute, verifiedHash)).rejects.toThrow('transient notes failure');
        await expect(resolveAndroidBackfill(repo, tag, execute)).resolves.toEqual(target);
        await publishAndroidBackfill(cwd, repo, target, execute, verifiedHash);
        await publishAndroidBackfill(cwd, repo, target, execute, verifiedHash);
        expect(uploads).toBe(2);
        expect(body.match(/caxri-android-backfill:/gu)).toHaveLength(1);
    });

    it('rejects an APK changed after its trusted signature check', async () => {
        const run = commands();
        await expect(publishAndroidBackfill(await bundle(), repo, { tag, sha, releaseId: 123 }, run, 'different hash')).rejects.toThrow('changed after');
        expect(run.mock.calls.some(([, arguments_]) => arguments_[1] === 'upload')).toBe(false);
    });

    it.each(['valid', 'wrong-key', 'wrong-package', 'wrong-version', 'wrong-abi', 'invalid-signature', 'missing-signing'])('independently verifies historical APK identity and release signing: %s', async (scenario) => {
        const digest = createHash('sha256').update('synthetic release certificate').digest('hex');
        const environment = {
            ANDROID_SDK_ROOT: '/fixture/sdk', JAVA_HOME: '/fixture/jdk',
            CAXRI_ANDROID_KEYSTORE_PATH: '/fixture/release.jks', CAXRI_ANDROID_KEY_ALIAS: 'release',
            CAXRI_ANDROID_KEYSTORE_PASSWORD: 'fixture-password', CAXRI_ANDROID_KEY_PASSWORD: 'fixture-password',
        };
        if (scenario === 'missing-signing') environment.CAXRI_ANDROID_KEY_PASSWORD = '';
        const execute: BackfillCommand = async (command) => {
            if (command.endsWith('/aapt2')) {
                return `package: name='${scenario === 'wrong-package' ? 'com.example.other' : 'com.caxri.mobile'}' versionCode='104' versionName='${scenario === 'wrong-version' ? '0.0.105' : '0.0.104'}'\nnative-code: '${scenario === 'wrong-abi' ? 'x86' : 'arm64-v8a'}'\n`;
            }
            if (command.endsWith('/apksigner')) {
                if (scenario === 'invalid-signature') throw new Error('APK signature invalid');
                return `Signer #1 certificate SHA-256 digest: ${scenario === 'wrong-key' ? '0'.repeat(64) : digest}\n`;
            }
            return `SHA256: ${digest.toUpperCase().match(/../gu)!.join(':')}\n`;
        };
        const result = verifyAndroidBackfill(await bundle(), tag, environment, execute);
        if (scenario === 'valid') await expect(result).resolves.toBe(verifiedHash);
        else await expect(result).rejects.toThrow();
    });

    it('binds the privileged route to main and its owner while leaving a blank dispatch non-publishing', async () => {
        const workflow = parse(await readFile(new URL('../../../../.github/workflows/release.yml', import.meta.url), 'utf8')) as {
            jobs: Record<string, { if: string; permissions: Record<string, string>; steps: Array<{ name?: string; run?: string; with?: Record<string, string>; env?: Record<string, string> }> }>;
        };
        const backfill = workflow.jobs['android-backfill']!;
        expect(backfill.if).toContain("github.ref == 'refs/heads/main'");
        expect(backfill.if).toContain("github.actor == 'tjx666'");
        expect(backfill.if).toContain("github.triggering_actor == 'tjx666'");
        expect(backfill.if).toContain("github.event_name == 'workflow_dispatch'");
        expect(backfill.if).toContain("inputs.android_release_tag != ''");
        expect(workflow.jobs.rehearsal!.if).toContain("inputs.android_release_tag == ''");
        expect(workflow.jobs['linux-natives']!.if).toContain("inputs.android_release_tag == ''");
        expect(backfill.steps.some((step) => step.with?.ref === '${{ steps.target.outputs.sha }}')).toBe(true);
        const build = backfill.steps.find((step) => step.name === 'Build the release-signed Android bundle')!;
        expect(Object.keys(build.env!).filter((key) => key.startsWith('CAXRI_ANDROID_'))).toHaveLength(4);
        expect(build.run).toContain('verify');
        expect(JSON.stringify(backfill.steps)).toContain('steps.signed_apk.outputs.apk_sha256');
        expect(JSON.stringify(backfill.steps)).toContain('update-bundle-receipts.ts');
        expect(JSON.stringify(backfill.steps)).toContain('android-release-signing-environment.json');
        expect(build.run).toContain('build:update-bundle');
        expect(build.run).toContain("trap 'rm -f \"$keystore\"' EXIT");
        expect(backfill.permissions).toEqual({ contents: 'write' });
    });
});
