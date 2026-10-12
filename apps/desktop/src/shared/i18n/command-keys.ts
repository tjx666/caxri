/**
 * Key derivation for the `commands` namespace, shared by the Renderer palette and Main's native menu so both look up
 * the same entries. Pure string functions: callers own the dictionary lookup and the English fallback, because command
 * ids contributed by extensions or the View catalog are open-ended and may have no translation.
 */
export function commandTitleKey(commandId: string): string {
    return `commands.${commandId}`;
}

export function commandDescriptionKey(commandId: string): string {
    return `commands.description.${commandId}`;
}

/**
 * Catalog categories are English phrases (`Secondary Side Bar`); their key is the camelCased phrase
 * (`commands.category.secondarySideBar`).
 */
export function commandCategoryKey(category: string): string {
    const words = category.trim().split(/\s+/u);
    const camel = words
        .map((word, index) =>
            index === 0
                ? word.toLowerCase()
                : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join('');
    return `commands.category.${camel}`;
}
