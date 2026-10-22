import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    collectReactCompilerBailouts,
    collectReactCompilerBailoutsForFile,
    diffBailoutLedger,
    groupBailoutReasons,
} from '../react-compiler-coverage';
import { knownReactCompilerBailouts } from '../react-compiler-known-bailouts';

const repoRoot = resolve(import.meta.dirname, '../..');
const rendererRoot = 'apps/desktop/src/renderer/src';

async function listRendererSources(): Promise<string[]> {
    const files: string[] = [];
    const matches = glob(`${rendererRoot}/**/*.{ts,tsx}`, {
        cwd: repoRoot,
        exclude: (path) =>
            path.includes('__tests__') || /\.(?:test|type-test)\.tsx?$|\.d\.ts$/.test(path),
    });
    for await (const file of matches) files.push(resolve(repoRoot, file));
    return files.toSorted((left, right) => left.localeCompare(right));
}

describe('React Compiler coverage', () => {
    it('reports a hook the compiler skips', async () => {
        const source = `
            export function useSave(save) {
                const [busy, setBusy] = useState(false);
                const run = async () => {
                    try { await save(); } finally { setBusy(false); }
                };
                return { busy, run };
            }`;
        const bailouts = await collectReactCompilerBailouts(
            source,
            resolve(repoRoot, `${rendererRoot}/probe.ts`),
            repoRoot,
        );
        expect(bailouts.map(({ reason }) => reason)).toEqual([
            '(BuildHIR::lowerStatement) Handle TryStatement without a catch clause',
        ]);
    });

    it('fails on an unlisted bailout and on a ledger entry that now compiles', () => {
        expect(
            diffBailoutLedger({ 'a.ts': ['new', 'kept'] }, { 'a.ts': ['kept'], 'b.ts': ['fixed'] }),
        ).toEqual({ unexpected: ['a.ts: new'], stale: ['b.ts: fixed'] });
    });

    /**
     * The build compiles the Renderer silently: a `try`/`finally`, `??=`, or hoisted function makes the compiler skip
     * the whole component, so it loses memoization with no warning. New code must compile; the ledger only shrinks.
     */
    it('matches the Renderer known-bailout ledger exactly', async () => {
        const files = await listRendererSources();
        const bailouts = (
            await Promise.all(
                files.map((file) => collectReactCompilerBailoutsForFile(file, repoRoot)),
            )
        ).flat();
        const { unexpected, stale } = diffBailoutLedger(
            groupBailoutReasons(bailouts),
            knownReactCompilerBailouts,
        );
        expect(
            unexpected,
            'Rewrite these so React Compiler compiles them (see .agents/skills/react/SKILL.md)',
        ).toEqual([]);
        expect(stale, 'These now compile: delete them from the ledger').toEqual([]);
    }, 300_000);
});
