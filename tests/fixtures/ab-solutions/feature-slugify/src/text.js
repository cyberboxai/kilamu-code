/** Capitalize the first letter of a string. */
export function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** URL slug: lowercase ASCII letters and digits, accents stripped, words joined by single dashes. */
export function slugify(input) {
  return String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
