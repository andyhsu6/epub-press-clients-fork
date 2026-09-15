// Single escaping implementation for every EPUB template interpolation.
// XML metacharacters reaching toc.ncx / content.opf / chapter*.html make the
// part unparseable, which in EPUB 2 means the reader rejects the package.
export function encodeXml(input = '') {
    return String(input)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
