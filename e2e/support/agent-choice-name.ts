/**
 * Matches a create-menu or Create Session dialog choice by its label. An Agent whose CLI the availability probe cannot
 * resolve also reads "Not installed" in its accessible name, which an exact name lookup would miss.
 */
export function agentChoiceName(label: string): RegExp {
    return new RegExp(
        `^${label.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}(?: Not installed)?$`,
        'u',
    );
}
