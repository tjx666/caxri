/**
 * Fixture for `caxri/native-title`, plain JSX because `scripts/` has no JSX runtime configured. Each `violation*`
 * function holds one mouse-only native tooltip; `allowedShapes` holds what the rule must leave alone.
 */

const element = document.body;

export function violationJsxHostElement(path) {
    return <span title={path}>{path}</span>;
}

export function violationAssignment(path) {
    element.title = path;
}

export function violationSetAttribute(path) {
    element.setAttribute('title', path);
}

export function violationGeneratedHtml(path) {
    return `<span class="path" title="${path}">${path}</span>`;
}

/** `document.title` names the window, and `title` on a component is that component's own prop. */
export function allowedShapes(Dialog) {
    document.title = 'Caxri';
    return <Dialog title="Settings" />;
}
