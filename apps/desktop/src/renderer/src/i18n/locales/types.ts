/**
 * Shape a translated namespace must satisfy: exactly the keys of its English source module, each mapped to a string. A
 * missing or misspelled key fails type checking instead of falling back to English at runtime.
 */
export type TranslatedNamespace<Source> = { readonly [Key in keyof Source]: string };
