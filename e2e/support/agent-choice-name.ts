/**
 * Matches a create-menu or Create Session dialog choice by its label. An Agent whose CLI the availability probe cannot
 * resolve also reads "Not installed" in its accessible name (or "Signed out" when its CLI reports it is signed out),
 * and the Agent a split-button press repeats reads "Last used", both of which an exact name lookup would miss.
 */
export function agentChoiceName(label: string): RegExp {
    return new RegExp(
        `^${label.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}(?: (?:Not installed|Signed out))?(?: Last used)?$`,
        'u',
    );
}
