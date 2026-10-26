import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const rendererRoot = fileURLToPath(new URL('../src', import.meta.url));
/**
 * `color` and `file` are the sanctioned native inputs: the OS color and file pickers have no shadcn equivalent (a
 * `file` input stays hidden behind a Button that opens it). Boolean controls must use the shared Switch/Checkbox
 * primitives (DESIGN.md "Spacing and radius" contract paragraph).
 */
const nativeInputTypes = new Set(['color', 'file']);
const allowedArbitraryClasses = new Set([
    'gap-[5px]',
    'h-[3px]',
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
    // Agent Chat transcript beside the message rail: DESIGN.md "Spacing and radius" keeps 16px while the centered
    // column's margin clears the rail and grows toward 28px only as a narrow Chat loses that margin.
    'pl-[clamp(1rem,calc(1.75rem_-_(100%_-_48rem)_/_2),1.75rem)]',
    // Session hover Pin/Archive cluster: DESIGN.md "Primary Sidebar" reserves this width so titles fade before the
    // icons instead of painting through their transparent strokes.
    'pr-[var(--session-hover-actions)]',
    // Project heading Customize Icon/New Session cluster follows the same hover-cluster rule.
    'pr-[var(--project-hover-actions)]',
    'pt-[3px]',
    'px-[5px]',
    // The two status-bar glyph boxes, sized to the text tier beside them; DESIGN.md "Spacing and radius" states why
    // they are declared on the shared recipes instead of at each call site.
    'size-[12px]',
    'size-[13px]',
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

/**
 * Global stylesheets whose rules cascade against Tailwind's layers.
 */
const globalStylesheets = [
    'theme.css',
    'styles.css',
    'markdown-preview.css',
    'process-explorer.css',
];
/**
 * Bare form-control element selectors Tailwind preflight owns inside `@layer base`.
 */
const formControlSelectorPattern = /(?<![\w.#[-])(?:button|input|textarea|select)(?![\w-])/;

/**
 * Collects selectors of style rules that sit outside every at-rule block except `@media` (top-level `@media` contents
 * are still unlayered and cascade identically). `@layer`, `@theme`, `@keyframes`, and other at-rule blocks are skipped
 * opaquely.
 */
function collectUnlayeredSelectors(css: string): string[] {
    const source = css.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/@[\w-][^{};]*;/g, '');
    const selectors: string[] = [];
    const findMatchingBrace = (text: string, openIndex: number): number => {
        let depth = 0;
        for (let index = openIndex; index < text.length; index++) {
            if (text[index] === '{') depth++;
            if (text[index] === '}' && --depth === 0) return index;
        }
        return text.length;
    };
    const walk = (block: string): void => {
        let index = 0;
        while (index < block.length) {
            const open = block.indexOf('{', index);
            if (open === -1) break;
            const prelude = block.slice(index, open).trim();
            const close = findMatchingBrace(block, open);
            if (prelude.startsWith('@media')) {
                walk(block.slice(open + 1, close));
            } else if (!prelude.startsWith('@')) {
                selectors.push(prelude);
            }
            index = close + 1;
        }
    };
    walk(source);
    return selectors;
}

/**
 * Chrome regions separate by `bg-surface`/`bg-background` steps, VS Code style, never by border hairlines. These files
 * own those seams; a `border-border` here reintroduces the removed lines. Standalone divider lines inside a single
 * surface use `components/ui/separator.tsx` instead.
 */
const borderlessChromeFiles = [
    'features/workbench/panel-divider.tsx',
    'features/workbench/pane-tab-bar.tsx',
    'features/status-bar/status-bar.tsx',
    'features/status-bar/active-file-status.tsx',
    'features/status-bar/branch-picker.tsx',
    'features/status-bar/screencast-mode-chip.tsx',
    'features/status-bar/workbench-root-picker.tsx',
    'features/secondary-sidebar/secondary-sidebar.tsx',
    'features/settings/settings-workbench-page.tsx',
    // features/primary-sidebar/primary-sidebar.tsx and features/process-explorer/process-explorer-app.tsx
    // also had their chrome seams removed, but keep legitimate in-surface borders (dashed CTA,
    // table column rules) this blanket guard cannot distinguish.
];

describe('Renderer design contract', () => {
    it('rejects spinning classes without a reduced-motion fallback', async () => {
        const paths = await listProductionSources(rendererRoot);
        const violationsByFile = await Promise.all(
            paths.map(async (path): Promise<string[]> => {
                const source = await readFile(path, 'utf8');
                const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
                const violations: string[] = [];
                const visit = (node: ts.Node): void => {
                    if (
                        ts.isStringLiteral(node) ||
                        ts.isNoSubstitutionTemplateLiteral(node) ||
                        ts.isTemplateHead(node) ||
                        ts.isTemplateMiddle(node) ||
                        ts.isTemplateTail(node)
                    ) {
                        const classes = new Set(node.text.split(/\s+/u));
                        if (
                            classes.has('animate-spin') &&
                            !classes.has('motion-reduce:animate-none')
                        )
                            violations.push(
                                sourceLocation(path, sourceFile, node.getStart(sourceFile)),
                            );
                    }
                    ts.forEachChild(node, visit);
                };
                visit(sourceFile);
                return violations;
            }),
        );

        expect(violationsByFile.flat(), 'spinners must honor reduced motion').toEqual([]);
    });

    it('keeps chrome seams borderless (background steps, not border lines)', async () => {
        const offenders = (
            await Promise.all(
                borderlessChromeFiles.map(async (file) => {
                    const source = await readFile(join(rendererRoot, file), 'utf8');
                    return source.includes('border-border') ? [file] : [];
                }),
            )
        ).flat();
        expect(
            offenders,
            'chrome seams must separate via bg-surface/bg-background steps; use components/ui/separator.tsx for standalone lines inside a surface',
        ).toEqual([]);
    });

    it('keeps form-control element resets inside @layer in global stylesheets', async () => {
        // Unlayered CSS beats every `@layer` rule, so a bare `button { font: inherit }` outside
        // `@layer` silently kills font utilities (`text-[10px]`, `font-bold`, …) app-wide: the
        // regression behind the Git panel's mismatched CHANGES/COMMITS headers. Tailwind's
        // preflight already resets form controls inside `@layer base`.
        const offendersByFile = await Promise.all(
            globalStylesheets.map(async (name): Promise<string[]> => {
                const css = await readFile(join(rendererRoot, 'styles', name), 'utf8');
                return collectUnlayeredSelectors(css)
                    .filter((selector) =>
                        selector
                            .split(',')
                            .some((part) => formControlSelectorPattern.test(part.trim())),
                    )
                    .map((selector) => `${name}: ${selector}`);
            }),
        );
        expect(
            offendersByFile.flat(),
            'unlayered rules matching button/input/textarea/select override Tailwind utilities; move them into @layer base',
        ).toEqual([]);
    });

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

    it('gates the shared Button and the Session history controls hover affordances behind the disabled state', async () => {
        // A disabled button still matches `:hover` in CSS even though Chromium dispatches no pointer events to it, so
        // an ungated `hover:` utility paints a hover fill under a cursor whose click does nothing. `aria-disabled:` is
        // the second half of the same contract: a busy control that must keep keyboard focus cannot set the native
        // attribute, and `:enabled` still matches it, so only `not-aria-disabled:` suppresses its hover there.
        // The Button recipe is the shared obligation; the history arrows are listed because they add their own hover
        // utility on top of it. Other consumers that pass `disabled` are not scanned yet; widening this to every
        // `.tsx` needs a way to tell a disabled-capable control from an always-interactive one first.
        const paths = [
            join(rendererRoot, 'components/ui/button.tsx'),
            join(rendererRoot, 'features/primary-sidebar/session-history-navigation.tsx'),
        ];
        const violationsByFile = await Promise.all(
            paths.map(async (path): Promise<string[]> => {
                const source = await readFile(path, 'utf8');
                const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
                return source
                    .matchAll(/([\w-]*:?)hover:/g)
                    .filter(
                        (match) =>
                            !['enabled:', 'not-aria-disabled:', 'group-', 'peer-'].includes(
                                match[1],
                            ),
                    )
                    .map((match) => sourceLocation(path, sourceFile, match.index))
                    .toArray();
            }),
        );

        expect(
            violationsByFile.flat(),
            'gate `hover:` behind `enabled:` or `not-aria-disabled:` so a disabled control never renders a hover affordance',
        ).toEqual([]);
    });
});
