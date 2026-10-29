import type { Rule } from 'eslint';
/**
 * Array methods whose callbacks run synchronously while their caller runs, so a call inside one executes in the
 * caller's render when the caller is a component or hook.
 */
const synchronousCallbackMethods = new Set([
    'every',
    'filter',
    'find',
    'findLast',
    'flatMap',
    'map',
    'reduce',
    'some',
    'sort',
    'toSorted',
]);

/**
 * Hooks whose callback runs during render, so its result is cached by its dependencies.
 */
const renderCallbackHooks = new Set(['useMemo']);

/**
 * Structural view of the ESTree fields the walk reads, since `Rule.Node['parent']` is a wide union.
 */
interface LooseNode {
    computed?: boolean;
    id?: { name?: string; type: string } | null;
    key?: unknown;
    parent: LooseNode | null;
    property?: unknown;
    shorthand?: boolean;
    type: string;
}

type FunctionNode = Rule.Node & {
    id?: { name: string } | null;
    type: 'ArrowFunctionExpression' | 'FunctionDeclaration' | 'FunctionExpression';
};

function isFunction(node: Rule.Node): node is FunctionNode {
    return ['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(
        node.type,
    );
}

/**
 * Name a function was declared or assigned under, looking through `memo()` and `forwardRef()` wrappers.
 */
function functionName(node: FunctionNode): string | undefined {
    if (node.id) return node.id.name;
    let parent: LooseNode | null = (node as unknown as LooseNode).parent;
    while (parent?.type === 'CallExpression') parent = parent.parent;
    if (parent?.type !== 'VariableDeclarator') return undefined;
    return parent.id?.type === 'Identifier' ? parent.id.name : undefined;
}

function isComponentOrHookName(name: string | undefined): boolean {
    return name !== undefined && /^(?:[A-Z]|use[A-Z0-9])/u.test(name);
}

function calleeName(call: Rule.Node): string | undefined {
    if (call.type !== 'CallExpression') return undefined;
    const { callee } = call;
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier')
        return callee.property.name;
    return undefined;
}

/**
 * Whether a function runs during its caller's render: an array callback or a `useMemo` callback.
 */
function isRenderTimeCallback(node: FunctionNode): boolean {
    const call = node.parent;
    if (call.type !== 'CallExpression' || !call.arguments.includes(node as never)) return false;
    const name = calleeName(call);
    if (name === undefined) return false;
    if (renderCallbackHooks.has(name)) return true;
    return call.callee.type === 'MemberExpression' && synchronousCallbackMethods.has(name);
}

/**
 * Whether `node` is the fallback in `t = translate` (a parameter or destructuring default) or `x.t ?? translate`: a
 * presentation helper that quietly falls back to the global snapshot instead of requiring its caller's `t`.
 */
function isDefaultTranslate(node: Rule.Node, parent: LooseNode): boolean {
    if (parent.type === 'AssignmentPattern') {
        return (parent as unknown as { right?: unknown }).right === node;
    }
    if (parent.type !== 'LogicalExpression') return false;
    const { left, operator, right } = parent as unknown as {
        left: { name?: string; property?: { name?: string }; type: string };
        operator: string;
        right: unknown;
    };
    if (right !== node || (operator !== '??' && operator !== '||')) return false;
    const leftName = left.type === 'Identifier' ? left.name : left.property?.name;
    return leftName === 't';
}

/**
 * The module-level `translate()` reads the locale store once and returns a snapshot. The React Compiler memoizes a
 * component or hook by its inputs, and the locale is not an input, so a render-time `translate()` keeps the previous
 * language after a runtime language switch. Components and hooks must use the `t` from `useTranslation()`; helpers they
 * call take `t` as a parameter.
 */
const rule: Rule.RuleModule = {
    meta: {
        messages: {
            defaultTranslate:
                'Do not default a `t` parameter to the module-level `translate`: a caller that forgets to pass `t` silently renders the previous language after a runtime language switch. Make `t` required and pass `useTranslation().t` from components or `translate` from an event or store entry point.',
            renderTranslate:
                'Do not use the module-level `translate` while rendering: React Compiler caches the result across a language switch. Use `t` from `useTranslation()` and pass it to helpers.',
        },
        type: 'problem',
        schema: [],
    },
    create(context) {
        const translateBindings = new Set<string>();

        return {
            ImportDeclaration(node) {
                if (
                    typeof node.source.value !== 'string' ||
                    !/i18n(?:\/translate)?$/u.test(node.source.value)
                )
                    return;
                for (const specifier of node.specifiers) {
                    if (
                        specifier.type === 'ImportSpecifier' &&
                        specifier.imported.type === 'Identifier' &&
                        specifier.imported.name === 'translate'
                    ) {
                        translateBindings.add(specifier.local.name);
                    }
                }
            },
            Identifier(node) {
                if (!translateBindings.has(node.name)) return;
                const parent = (node as unknown as LooseNode).parent as LooseNode;
                if (isDefaultTranslate(node, parent)) {
                    context.report({ messageId: 'defaultTranslate', node });
                    return;
                }
                // Declarations and non-reference positions (`obj.translate`, `{ translate: 1 }`) are not uses.
                if (
                    parent.type === 'ImportSpecifier' ||
                    (parent.type === 'MemberExpression' &&
                        parent.property === node &&
                        !parent.computed) ||
                    (parent.type === 'Property' &&
                        parent.key === node &&
                        !parent.computed &&
                        !parent.shorthand)
                )
                    return;
                let current: Rule.Node | null = (node as Rule.Node).parent;
                while (current) {
                    if (isFunction(current)) {
                        if (isComponentOrHookName(functionName(current))) {
                            context.report({ messageId: 'renderTranslate', node });
                            return;
                        }
                        if (!isRenderTimeCallback(current)) return;
                    }
                    current = current.parent;
                }
            },
        };
    },
};

export default rule;
