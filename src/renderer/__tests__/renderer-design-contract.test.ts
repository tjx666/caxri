import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const rendererRoot = fileURLToPath(new URL('../src', import.meta.url));
/**
 * `color` is the one remaining sanctioned native input: the OS color picker has no shadcn equivalent. Boolean controls
 * must use the shared Switch/Checkbox primitives (DESIGN.md "Spacing and radius" contract paragraph).
 */
const nativeInputTypes = new Set(['color']);
const allowedArbitraryClasses = new Set([
    'gap-[5px]',
    'h-[34px]',
    'h-[360px]',
    'leading-[1.45]',
    'leading-[1.5]',
    'max-h-[360px]',
    'max-w-[420px]',
    'max-w-[460px]',
    'max-w-[540px]',
    'max-w-[560px]',
    'min-h-[120px]',
    'min-h-[180px]',
    'min-h-[34px]',
    'min-h-[38px]',
    'min-h-[72px]',
    'min-w-[80px]',
    'pb-[3px]',
    'pl-[78px]',
    'pl-[84px]',
    'pt-[3px]',
    'px-[5px]',
    'size-[26px]',
    'text-[10px]',
    'text-[11px]',
    'text-[12px]',
    'text-[13px]',
    'text-[15px]',
    'tracking-[0.04em]',
    'tracking-[0.06em]',
    'w-[13px]',
    'w-[26px]',
    'w-[3px]',
    'w-[78px]',
]);
const arbitraryDesignClassPattern =
    /(?<![\w-])(?:[\w-]+:)*-?(?:text-\[(?!var\()[^\]]+\]|(?:h|w|min-h|max-h|min-w|max-w|size)-\[-?\d+(?:\.\d+)?px\]|(?:leading|tracking|gap|gap-x|gap-y|space-x|space-y|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|rounded(?:-[trbl]{1,2})?)-\[[^\]]+\])/g;

async function listProductionSources(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map(async (entry): Promise<string[]> => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return listProductionSources(path);
            if (
                entry.isFile() &&
                (path.endsWith('.ts') || path.endsWith('.tsx')) &&
                !path.endsWith('.test.ts') &&
                !path.endsWith('.test.tsx')
            ) {
                return [path];
            }
            return [];
        }),
    );
    return nested.flat();
}

function sourceLocation(path: string, sourceFile: ts.SourceFile, position: number): string {
    const { line } = sourceFile.getLineAndCharacterOfPosition(position);
    return `${relative(rendererRoot, path).split(sep).join('/')}:${line + 1}`;
}

describe('Renderer design contract', () => {
    it('recognizes guarded arbitrary class shapes before applying the allowlist', () => {
        expect(
            'text-[9px] h-[26px] min-w-[73px] -mt-[7px] hover:-mx-[3px] rounded-[5px]'.match(
                arbitraryDesignClassPattern,
            ),
        ).toEqual([
            'text-[9px]',
            'h-[26px]',
            'min-w-[73px]',
            '-mt-[7px]',
            'hover:-mx-[3px]',
            'rounded-[5px]',
        ]);
    });

    it('routes text inputs through the shared Input primitive', async () => {
        const paths = (await listProductionSources(rendererRoot)).filter((path) =>
            path.endsWith('.tsx'),
        );
        const violationsByFile = await Promise.all(
            paths.map(async (path): Promise<string[]> => {
                const sourceFile = ts.createSourceFile(
                    path,
                    await readFile(path, 'utf8'),
                    ts.ScriptTarget.Latest,
                    true,
                    ts.ScriptKind.TSX,
                );
                const fileViolations: string[] = [];
                const visit = (node: ts.Node): void => {
                    if (
                        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
                        node.tagName.getText(sourceFile) === 'input'
                    ) {
                        const typeAttribute = node.attributes.properties.find(
                            (attribute): attribute is ts.JsxAttribute =>
                                ts.isJsxAttribute(attribute) &&
                                attribute.name.getText(sourceFile) === 'type',
                        );
                        const type =
                            typeAttribute?.initializer &&
                            ts.isStringLiteral(typeAttribute.initializer)
                                ? typeAttribute.initializer.text
                                : undefined;
                        if (!type || !nativeInputTypes.has(type)) {
                            fileViolations.push(
                                sourceLocation(path, sourceFile, node.getStart(sourceFile)),
                            );
                        }
                    }
                    ts.forEachChild(node, visit);
                };
                visit(sourceFile);
                return fileViolations;
            }),
        );

        expect(violationsByFile.flat(), 'raw text inputs bypass components/ui/input.tsx').toEqual(
            [],
        );
    });

    it('rejects arbitrary typography, spacing, and radius classes outside DESIGN.md', async () => {
        const paths = await listProductionSources(rendererRoot);
        const violationsByFile = await Promise.all(
            paths.map(async (path): Promise<string[]> => {
                const source = await readFile(path, 'utf8');
                const fileViolations: string[] = [];
                for (const match of source.matchAll(arbitraryDesignClassPattern)) {
                    const className = match[0].replace(/^(?:[\w-]+:)*/, '');
                    if (!allowedArbitraryClasses.has(className)) {
                        const sourceFile = ts.createSourceFile(
                            path,
                            source,
                            ts.ScriptTarget.Latest,
                            true,
                        );
                        fileViolations.push(
                            `${sourceLocation(path, sourceFile, match.index)} ${match[0]}`,
                        );
                    }
                }
                return fileViolations;
            }),
        );

        expect(
            violationsByFile.flat(),
            'arbitrary classes missing from the DESIGN.md allowlist',
        ).toEqual([]);
    });
});
