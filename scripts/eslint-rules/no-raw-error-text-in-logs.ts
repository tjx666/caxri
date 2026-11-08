import type { Rule } from 'eslint';
import type { Node, ObjectExpression } from 'estree';

/**
 * Resolves a local identifier to the expressions ever written to it (its initializer and assignments), or none for a
 * parameter, import, or global.
 */
type WrittenValues = (identifier: Node) => readonly Node[];

/**
 * Identifier names that conventionally hold a caught value.
 */
const errorLikeNames = new Set(['cause', 'e', 'err', 'error', 'failure', 'fault']);
const stderrNames = new Set(['stderr', 'stderrText']);

function propertyOwnerName(node: Node): string {
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier')
        return node.property.name;
    return '';
}

function isErrorLike(node: Node): boolean {
    if (node.type === 'Identifier') return errorLikeNames.has(node.name);
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier')
        return errorLikeNames.has(node.property.name);
    return false;
}

/**
 * Whether the node itself is raw error or stderr text: any `.message` member, `errorMessage(...)`, `String(error)`, or
 * a `stderr` identifier or member.
 */
function isRawText(node: Node): boolean {
    if (node.type === 'Identifier') return stderrNames.has(node.name);
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
        if (stderrNames.has(node.property.name)) return true;
        // `error.stack` opens with the message (V8 renders `Name: message` before the frames).
        if (
            node.property.name === 'stack' &&
            /(?:^|[a-z])(?:error|err|cause|fault|failure)$/i.test(propertyOwnerName(node.object))
        )
            return true;
        // Any `.message` (`error.message`, `reply.error.message`, `wire.message`) is free text by construction.
        return node.property.name === 'message';
    }
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return false;
    if (node.callee.name === 'errorMessage') return true;
    return (
        node.callee.name === 'String' &&
        node.arguments.length === 1 &&
        node.arguments[0].type !== 'SpreadElement' &&
        isErrorLike(node.arguments[0])
    );
}

/**
 * The sub-expressions through which a field value can still carry text.
 */
function textCarriers(node: Node): Node[] {
    switch (node.type) {
        case 'ConditionalExpression':
            return [node.consequent, node.alternate];
        case 'LogicalExpression':
        case 'BinaryExpression':
            return [node.left, node.right];
        case 'TemplateLiteral':
            return node.expressions;
        case 'CallExpression':
            // `clip(error.message, 200)`, `redact(stderr)`: wrapping text still logs text. A method call on text
            // (`error.message.slice(0, 80)`) is still the message.
            return [
                ...node.arguments.filter((argument) => argument.type !== 'SpreadElement'),
                ...(node.callee.type === 'MemberExpression' ? [node.callee.object] : []),
            ];
        case 'MemberExpression':
            // `.length` is a size, not text.
            return !node.computed &&
                node.property.type === 'Identifier' &&
                node.property.name === 'length'
                ? []
                : [node.object];
        default: {
            // TypeScript wrappers (`as`, `!`) carry the wrapped value in `expression`.
            const wrapped = (node as unknown as { expression?: Node }).expression;
            return wrapped !== undefined && node.type.startsWith('TS') ? [wrapped] : [];
        }
    }
}

/**
 * Finds raw text anywhere in a field value expression, except under `.length` (a size is content-free). A local
 * variable counts through what was written to it, so `const message = errorMessage(error)` followed by `{ error:
 * message }` is still raw text.
 */
function hasRawText(root: Node, writtenValues: WrittenValues): boolean {
    const pending: Node[] = [root];
    const visited = new Set<Node>();
    for (let node = pending.pop(); node; node = pending.pop()) {
        if (visited.has(node)) continue;
        visited.add(node);
        if (isRawText(node)) return true;
        pending.push(...textCarriers(node));
        if (node.type === 'Identifier') pending.push(...writtenValues(node));
    }
    return false;
}

/**
 * Whether a write binds the whole written expression to the identifier (`const x = …`, `x = …`), not one destructured
 * part of it: `const { outcome } = parse(result, stderr)` takes a parsed field, not the stderr text.
 */
function isWholeValueWrite(identifier: Rule.Node | Node): boolean {
    const parent = (identifier as Partial<Rule.Node>).parent;
    return (
        (parent?.type === 'VariableDeclarator' && parent.id === identifier) ||
        (parent?.type === 'AssignmentExpression' && parent.left === identifier)
    );
}

/**
 * Callee names that write a structured log record or forward fields to one.
 */
function isLogCall(node: Rule.Node): boolean {
    if (node.type !== 'CallExpression') return false;
    const { callee } = node;
    const name =
        callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' &&
                !callee.computed &&
                callee.property.type === 'Identifier'
              ? callee.property.name
              : undefined;
    return name !== undefined && /^(?:write|log\w*)$/i.test(name);
}

/**
 * Rejects raw error or stderr text in structured log fields. Diagnostics bundles copy the JSONL logs verbatim and the
 * logger redacts only home paths and credential-shaped tokens, so repository slugs, branch names, URLs, non-home
 * absolute paths, and stderr fragments embedded in a message reach an exported bundle. Spread `errorLogFields(error)`
 * from `@caxri/system` instead, or log a closed reason. Checked: every property of an object literal that is the
 * `fields` property of an options object or a direct argument of a logger-style call (`write`, `log*`), and a raw-text
 * expression passed directly to such a call. A site with a reviewed need for text opts out with `//
 * eslint-disable-next-line caxri/no-raw-error-text-in-logs -- <why this text is content-free>`.
 */
const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        schema: [],
        messages: {
            rawText:
                'Do not log raw error or stderr text: diagnostics bundles export log fields verbatim. Spread errorLogFields(error) from @caxri/system or log a closed reason.',
        },
    },
    create(context) {
        const writtenValues: WrittenValues = (identifier) => {
            if (identifier.type !== 'Identifier') return [];
            const scope = context.sourceCode.getScope(identifier);
            for (let current: typeof scope | null = scope; current; current = current.upper) {
                const variable = current.set.get(identifier.name);
                if (variable)
                    return variable.references.flatMap((reference) =>
                        reference.writeExpr && isWholeValueWrite(reference.identifier as Node)
                            ? [reference.writeExpr as Node]
                            : [],
                    );
            }
            return [];
        };
        /**
         * Reports each property of a log-feeding object literal whose value carries raw text.
         */
        function checkFields(object: ObjectExpression): void {
            for (const property of object.properties) {
                const value = property.type === 'Property' ? property.value : property.argument;
                if (hasRawText(value, writtenValues))
                    context.report({ node: property, messageId: 'rawText' });
            }
        }
        return {
            CallExpression(node) {
                if (!isLogCall(node)) return;
                for (const argument of node.arguments) {
                    if (argument.type === 'ObjectExpression') checkFields(argument);
                    else if (
                        argument.type !== 'SpreadElement' &&
                        hasRawText(argument, writtenValues)
                    )
                        context.report({ node: argument, messageId: 'rawText' });
                }
            },
            Property(node) {
                const { key, value } = node;
                const isFieldsKey =
                    !node.computed &&
                    ((key.type === 'Identifier' && key.name === 'fields') ||
                        (key.type === 'Literal' && key.value === 'fields'));
                if (isFieldsKey && value.type === 'ObjectExpression') checkFields(value);
            },
        };
    },
};

export default rule;
