import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKILLS_ROOT = join(PROJECT_ROOT, '.agents', 'skills');
const INVOCATION_CONTRACT = join(PROJECT_ROOT, '.agents', 'invocation.md');

const EXPLICIT_ONLY_SKILLS = [
    'audit-architecture-debt',
    'audit-ux',
    'go',
    'grill-me',
    'grill-with-docs',
    'release',
    'switch-worktree',
    'wait-what',
] as const;

interface SkillDocument {
    body: string;
    frontmatter: { 'disable-model-invocation'?: boolean; 'name': string };
}

function parseSkillDocument(source: string): SkillDocument {
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
    if (!match) throw new Error('SKILL.md must contain YAML frontmatter');
    const frontmatterLines = match[1].split('\n');
    const name = frontmatterLines
        .find((line) => line.startsWith('name:'))
        ?.slice('name:'.length)
        .trim();
    if (!name) throw new Error('SKILL.md frontmatter must contain a name');
    return {
        body: match[2],
        frontmatter: {
            'disable-model-invocation':
                frontmatterLines.includes('disable-model-invocation: true') || undefined,
            name,
        },
    };
}

async function installedSkillNames(): Promise<string[]> {
    const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
    const candidates = entries.filter((entry) => entry.isDirectory()).map(({ name }) => name);
    const names = await Promise.all(
        candidates.map(async (name) => {
            try {
                await access(join(SKILLS_ROOT, name, 'SKILL.md'));
                return name;
            } catch (error: unknown) {
                if (
                    typeof error === 'object' &&
                    error !== null &&
                    'code' in error &&
                    error.code === 'ENOENT'
                ) {
                    return null;
                }
                throw error;
            }
        }),
    );
    return names
        .filter((name): name is string => name !== null)
        .toSorted((left, right) => left.localeCompare(right));
}

async function readSkill(name: string): Promise<SkillDocument> {
    return parseSkillDocument(await readFile(join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8'));
}

async function skillMarkdownSources(): Promise<Array<{ path: string; source: string }>> {
    const sources: Array<{ path: string; source: string }> = [];

    async function collect(directory: string): Promise<void> {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                // This contract intentionally checks nested routed references in order.
                // eslint-disable-next-line no-await-in-loop
                await collect(path);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                // eslint-disable-next-line no-await-in-loop
                sources.push({ path, source: await readFile(path, 'utf8') });
            }
        }
    }

    await collect(SKILLS_ROOT);
    return sources;
}

async function implicitInvocationPolicy(name: string): Promise<boolean | undefined> {
    try {
        const source = await readFile(join(SKILLS_ROOT, name, 'agents', 'openai.yaml'), 'utf8');
        const document = parse(source) as {
            policy?: { allow_implicit_invocation?: boolean };
        };
        return document.policy?.allow_implicit_invocation;
    } catch (error: unknown) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            return undefined;
        }
        throw error;
    }
}

describe('contributor skill invocation contract', () => {
    it('pairs both explicit-only switches and keeps every other skill model-invoked', async () => {
        const explicitOnly = new Set<string>(EXPLICIT_ONLY_SKILLS);
        const skillNames = await installedSkillNames();
        for (const name of skillNames) {
            // This contract intentionally checks each independently installed skill in order.
            // eslint-disable-next-line no-await-in-loop
            const skill = await readSkill(name);
            // eslint-disable-next-line no-await-in-loop
            const policy = await implicitInvocationPolicy(name);
            const isFrontmatterDisablesModel =
                skill.frontmatter['disable-model-invocation'] === true;
            const isOpenaiDisablesModel = policy === false;

            expect(isFrontmatterDisablesModel, `${name} frontmatter/OpenAI policy symmetry`).toBe(
                isOpenaiDisablesModel,
            );
            expect(isFrontmatterDisablesModel, `${name} explicit-only membership`).toBe(
                explicitOnly.has(name),
            );
        }
    });

    it('keeps the documented explicit-only list aligned with the executable authority', async () => {
        const source = await readFile(INVOCATION_CONTRACT, 'utf8');
        const section =
            /<!-- explicit-only-skills:start -->([\s\S]*?)<!-- explicit-only-skills:end -->/u.exec(
                source,
            )?.[1];
        if (!section) throw new Error('Invocation contract is missing the explicit-only list');
        const documented = section
            .matchAll(/^- `([^`]+)`$/gmu)
            .map((match) => match[1])
            .toArray();
        expect(documented).toEqual([...EXPLICIT_ONLY_SKILLS]);
    });

    it('forbids executable cross-calls into explicit-only entry skills', async () => {
        const sources = await skillMarkdownSources();
        for (const { path, source } of sources) {
            const callLines = source
                .split('\n')
                .filter((line) => line.includes('Call the Skill tool'));
            for (const explicitOnly of EXPLICIT_ONLY_SKILLS) {
                const legacyEntryCall = new RegExp(
                    `${String.raw`\b(?:invoke|load|run|use)(?:\s+(?:a|project|project-local|separate|the))*\s+`}\`${explicitOnly}\`${String.raw`(?:\s+skill)?`}`,
                    'iu',
                );
                expect(
                    callLines.some((line) => line.includes(`"${explicitOnly}"`)),
                    `${path} must not call explicit-only skill ${explicitOnly}`,
                ).toBe(false);
                expect(
                    source,
                    `${path} must not use legacy prose to call explicit-only skill ${explicitOnly}`,
                ).not.toMatch(legacyEntryCall);
            }
        }
    });

    it('keeps routed Go references on the same invocation contract', async () => {
        const intake = await readFile(join(SKILLS_ROOT, 'go', 'references', 'intake.md'), 'utf8');
        const acceptanceLoop = await readFile(
            join(SKILLS_ROOT, 'go', 'references', 'acceptance-loop.md'),
            'utf8',
        );
        expect(intake).toContain('Call the Skill tool with "competitors"');
        expect(intake).toContain('a separate explicit `$release` workflow');
        expect(intake).not.toMatch(/invoke the project `release` skill/iu);
        expect(acceptanceLoop).toContain('Call the Skill tool with "acceptance"');
    });

    it('uses Skill tool calls instead of legacy slash-session prose', async () => {
        const grillMe = await readSkill('grill-me');
        const grillWithDocuments = await readSkill('grill-with-docs');
        expect(grillMe.body).toContain('Call the Skill tool with "grilling".');
        expect(grillWithDocuments.body).toContain(
            'Call the Skill tool twice, for "grilling" and "domain-modeling".',
        );
        expect(`${grillMe.body}\n${grillWithDocuments.body}`).not.toContain('Run a `/grilling`');
    });
});
