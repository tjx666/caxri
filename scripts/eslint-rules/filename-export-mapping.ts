import type { Rule } from 'eslint';
import type {
    ArrowFunctionExpression,
    FunctionDeclaration,
    FunctionExpression,
    Program,
} from 'estree';

/**
 * Converts a kebab-case filename stem (e.g. `file-tree-panel`, `use-command-shortcuts`) into its PascalCase or
 * camelCase mapping. `casing: 'pascal'` maps `file-tree-panel` -> `FileTreePanel`; `casing: 'camel'` maps
 * `use-command-shortcuts` -> `useCommandShortcuts`.
 */
function kebabToCasedIdentifier(stem: string, casing: 'camel' | 'pascal'): string {
    const words = stem.split('-').filter(Boolean);
    return words
        .map((word, index) => {
            const capitalized = word.charAt(0).toUpperCase() + word.slice(1);
            return casing === 'camel' && index === 0 ? word : capitalized;
        })
        .join('');
}

/**
 * The kebab-case filename stem is the first dot segment: `file-tree-panel.tsx` -> `file-tree-panel`;
 * `use-command-shortcuts.ts` -> `use-command-shortcuts`. Role suffixes (`.test`, `.stories`, ...) live after the stem
 * and are irrelevant here (files carrying them are excluded via `eslint.config.ts` `ignores`).
 */
function filenameStem(filename: string): string {
    const base = filename.split('/').pop() ?? filename;
    return base.split('.', 1)[0] ?? base;
}

const functionLikeNodeTypes = new Set([
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
]);

function isFunctionLike(
    node: { type: string } | null | undefined,
): node is FunctionDeclaration | FunctionExpression | ArrowFunctionExpression {
    return !!node && functionLikeNodeTypes.has(node.type);
}

/**
 * Collects every top-level named export identifier that binds to a function-like or class value: `export function Foo()
 * {}`, `export const useFoo = () => {}`, `export class Foo extends Component {}`, and re-export lists (`export { Foo
 * }`) that reference an earlier such declaration in the same module. Class components (e.g. an error boundary) are
 * included alongside function components since both satisfy the "component" naming contract.
 */
function exportedFunctionNames(program: Program): Set<string> {
    const bindableDeclarations = new Set<string>();
    const names = new Set<string>();

    for (const statement of program.body) {
        // A non-default `FunctionDeclaration`/`ClassDeclaration` (unlike its default-export
        // counterpart) always carries a name per the estree grammar, so `.id` is never null here.
        if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
            bindableDeclarations.add(statement.id.name);
        } else if (statement.type === 'VariableDeclaration') {
            for (const declarator of statement.declarations) {
                if (declarator.id.type === 'Identifier' && isFunctionLike(declarator.init)) {
                    bindableDeclarations.add(declarator.id.name);
                }
            }
        }
    }

    for (const statement of program.body) {
        if (statement.type !== 'ExportNamedDeclaration') continue;
        const exportDeclaration = statement;
        if (exportDeclaration.declaration) {
            const declaration = exportDeclaration.declaration;
            // Same as above: an exported, non-default `FunctionDeclaration`/`ClassDeclaration`
            // always has a name, so `.id` is never null here.
            if (
                declaration.type === 'FunctionDeclaration' ||
                declaration.type === 'ClassDeclaration'
            ) {
                names.add(declaration.id.name);
                // The estree `Declaration` union claims only Function/Class/Variable declarations, but the
                // TypeScript parser also emits `TSInterfaceDeclaration`, `TSTypeAliasDeclaration`, etc. at
                // runtime (e.g. `export interface ButtonProps`), so this check is NOT redundant: dropping
                // it crashes on `declaration.declarations`.
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- see above: @types/estree under-represents the TS AST
            } else if (declaration.type === 'VariableDeclaration') {
                for (const declarator of declaration.declarations) {
                    if (declarator.id.type === 'Identifier' && isFunctionLike(declarator.init)) {
                        names.add(declarator.id.name);
                    }
                }
            }
        }
        for (const specifier of exportDeclaration.specifiers) {
            const localName =
                specifier.local.type === 'Identifier' ? specifier.local.name : undefined;
            const exportedName =
                specifier.exported.type === 'Identifier' ? specifier.exported.name : undefined;
            if (localName && exportedName && bindableDeclarations.has(localName)) {
                names.add(exportedName);
            }
        }
    }

    return names;
}

/**
 * Enforces the naming contract from `.agents/skills/source-layout/SKILL.md`: a component file's primary export matches
 * the PascalCase mapping of its kebab-case filename (`file-tree-panel.tsx` exports `FileTreePanel`), and a `use-*.ts`
 * hook file's primary export matches the camelCase mapping (`use-command-shortcuts.ts` exports `useCommandShortcuts`).
 * Compound-component files (e.g. `dialog.tsx` exporting `Dialog`, `DialogContent`, `DialogTitle`, ...) satisfy the rule
 * as long as one export matches the mapping exactly.
 */
const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'require a component or hook file to export a name matching its filename mapping',
        },
        schema: [],
        messages: {
            missingMappedExport:
                "'{{filename}}' must export '{{expected}}' (the {{casing}} mapping of its filename); found: {{found}}.",
        },
    },
    create(context) {
        const filename = context.filename;
        const stem = filenameStem(filename);
        const isHook = filename.endsWith('.ts') && /^use-[a-z0-9-]+$/.test(stem);
        const casing = isHook ? 'camel' : 'pascal';
        const expected = kebabToCasedIdentifier(stem, casing);

        return {
            'Program:exit': function (node: Program) {
                const names = exportedFunctionNames(node);
                if (names.has(expected)) return;
                context.report({
                    node,
                    messageId: 'missingMappedExport',
                    data: {
                        filename: filename.split('/').pop() ?? filename,
                        expected,
                        casing: isHook ? 'camelCase' : 'PascalCase',
                        found: names.size > 0 ? [...names].join(', ') : '(no function export)',
                    },
                });
            },
        };
    },
};

export default rule;
