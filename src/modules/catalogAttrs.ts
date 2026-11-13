/**
 * Filterable product attribute keys shared by the storefront browse API and seeding.
 * Each product stores `attributes` as a Map of key -> string[] (a product can carry several
 * values per key, e.g. occasion: ["Daily","Casual"]). Adding a key here makes it a facet.
 */
export const FILTERABLE_ATTRS = ["strap", "color", "dial", "lock", "occasion", "movement", "gender"] as const;

export type FilterableAttr = (typeof FILTERABLE_ATTRS)[number];
