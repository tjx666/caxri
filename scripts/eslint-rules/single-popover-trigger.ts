import type { Rule } from 'eslint';

/**
 * Structural view of the JSX and ESTree fields the walk reads, since the ESLint node types do not include JSX.
 */
interface LooseNode {
    arguments?: LooseNode[];
    callee?: LooseNode;
    name?: LooseNode | string;
    object?: LooseNode;
    openingElement?: LooseNode;
    parent: LooseNode | null;
    property?: LooseNode;
    type: string;
}

const iterationMethods = new Set(['flatMap', 'map']);

/**
 * `Popover` / `PopoverTrigger`, or the namespaced `Popover.Root` / `Popover.Trigger` form.
 */
function elementName(element: LooseNode): string | undefined {
    const name = element.openingElement?.name;
    if (typeof name !== 'object') return undefined;
    if (name.type === 'JSXIdentifier') return name.name as string;
    if (name.type === 'JSXMemberExpression' && name.object?.type === 'JSXIdentifier')
        return `${name.object.name as string}.${name.property?.name as string}`;
    return undefined;
}

const isTrigger = (name: string | undefined) =>
    name === 'PopoverTrigger' || name === 'Popover.Trigger';
const isPopover = (name: string | undefined) => name === 'Popover' || name === 'Popover.Root';

function isIterationCallback(node: LooseNode): boolean {
    const call = node.parent;
    if (call?.type !== 'CallExpression' || !call.arguments?.includes(node)) return false;
    const { callee } = call;
    return (
        callee?.type === 'MemberExpression' &&
        callee.property?.type === 'Identifier' &&
        iterationMethods.has(callee.property.name as string)
    );
}

/**
 * Base UI 1.8.0 and 1.9.0 loop in `PopoverStore` / `syncTriggerCount` (React error 185) when one Popover owns several
 * registered triggers, which replaces the Workbench with the render-failure screen. Reports a second `PopoverTrigger`
 * under one `Popover`, and a trigger rendered from a `map` callback, which registers one per item. Use a controlled,
 * trigger-less Popover anchored to the clicked element instead (`editor-breadcrumbs.tsx`). Remove the rule once Base UI
 * no longer loops; see `.agents/skills/project-architecture/references/stack-baseline.md`.
 */
const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        messages: {
            secondTrigger:
                'A Popover may register only one PopoverTrigger: Base UI loops (React error 185) on a second. Use a controlled, trigger-less Popover with an anchor instead.',
            mappedTrigger:
                'A PopoverTrigger rendered per item registers several triggers on one Popover, which makes Base UI loop (React error 185). Use a controlled, trigger-less Popover with an anchor instead.',
        },
        schema: [],
    },
    create(context) {
        const triggerCounts = new Map<LooseNode, number>();
        return {
            JSXElement(node: Rule.Node) {
                const element = node as unknown as LooseNode;
                if (!isTrigger(elementName(element))) return;
                let isMapped = false;
                let ancestor = element.parent;
                while (
                    ancestor &&
                    !(ancestor.type === 'JSXElement' && isPopover(elementName(ancestor)))
                ) {
                    if (
                        (ancestor.type === 'ArrowFunctionExpression' ||
                            ancestor.type === 'FunctionExpression') &&
                        isIterationCallback(ancestor)
                    )
                        isMapped = true;
                    ancestor = ancestor.parent;
                }
                if (!ancestor) return;
                const count = (triggerCounts.get(ancestor) ?? 0) + 1;
                triggerCounts.set(ancestor, count);
                if (isMapped) context.report({ node, messageId: 'mappedTrigger' });
                else if (count > 1) context.report({ node, messageId: 'secondTrigger' });
            },
        };
    },
};

export default rule;
