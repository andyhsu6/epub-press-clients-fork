import { extractFromHtml, getSanitizeHtmlOptions, setSanitizeHtmlOptions } from '@extractus/article-extractor'
import JSZip from 'jszip';

// ─── Auto-Pagination Constants ───────────────────────────────────────────────
const MAX_PAGINATION_PAGES = 50;       // safety limit to prevent infinite loops
const PAGINATION_TIMEOUT_MS = 10000;   // per-page fetch timeout

// ─── URL Utilities ───────────────────────────────────────────────────────────
function resolveUrl(href, baseUrl) {
    if (!href || href === '#') return null;
    href = href.trim();

    // already absolute
    if (/^https?:\/\//i.test(href)) return href;

    // protocol-relative
    if (/^\/\//.test(href)) {
        const proto = baseUrl.match(/^(https?:)/i)?.[1] || 'https:';
        return proto + href;
    }

    // root-relative
    if (/^\//.test(href)) {
        const origin = baseUrl.match(/^https?:\/\/[^/]+/i)?.[0] || '';
        return origin + href;
    }

    // relative — resolve against the directory of baseUrl
    const base = baseUrl.replace(/\/?[^/]*$/, '');      // strip filename/last segment
    return base.replace(/\/+$/, '') + '/' + href.replace(/^\.?\//, '');
}

// ─── Next-Page Link Detection ────────────────────────────────────────────────
const NEXT_PAGE_TEXT_PATTERNS = [
    '下一页', '下一章', '下页', '后页', '下一篇', '下一节',
    'Next', 'Next Page', 'Next Chapter', 'Next »',
    '›', '››', '»', '>>', '＞', '＞＞',
];

function findNextPageUrl(html, currentUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Strategy 1: <link rel="next"> (HTML5 standard)
    const linkNext = doc.querySelector('link[rel="next"]');
    if (linkNext?.getAttribute('href')) {
        const url = resolveUrl(linkNext.getAttribute('href'), currentUrl);
        if (url && url !== currentUrl) return url;
    }

    // Strategy 2: <a rel="next">
    const aRelNext = doc.querySelector('a[rel="next"]');
    if (aRelNext?.getAttribute('href')) {
        const url = resolveUrl(aRelNext.getAttribute('href'), currentUrl);
        if (url && url !== currentUrl) return url;
    }

    // Strategy 3: common CSS class names
    const nextClassSelectors = [
        'a.next', 'a.pagination-next', 'a.next-page', 'a.next_page',
        'a.pgn__next', 'a.pager-next', 'a.paginator-next', 'a.jp-next',
        'a[class*="next"]',
        '.next a', '.pagination-next a', '.next-page a',
    ];
    for (const sel of nextClassSelectors) {
        const el = doc.querySelector(sel);
        if (el?.getAttribute('href')) {
            const url = resolveUrl(el.getAttribute('href'), currentUrl);
            if (url && url !== currentUrl) return url;
        }
    }

    // Strategy 4: <a> with matching visible text
    const allLinks = doc.querySelectorAll('a[href]');
    for (const a of allLinks) {
        const text = (a.textContent || '').trim();
        if (!text) continue;
        const match = NEXT_PAGE_TEXT_PATTERNS.some(p => {
            if (p.length <= 2) {
                // short punctuation — exact match
                return text === p;
            }
            return text.toLowerCase().includes(p.toLowerCase());
        });
        if (match) {
            const url = resolveUrl(a.getAttribute('href'), currentUrl);
            if (url && url !== currentUrl) return url;
        }
    }

    // ── Strategy 5: universal numbered-pagination detection ──────────────
    // Scan EVERY link on the page; extract page numbers from text AND from URL patterns.
    // Works regardless of container class name.

    // Helper: try to extract a page number from a URL string
    function pageNumFromUrl(urlStr) {
        const m = urlStr.match(/[?&](?:page|pagenumber|page_num|page_number|pageNo|pageIndex|pageindex|pg|pn)=\d+/i);
        if (m) return parseInt(m[0].match(/\d+/)[0], 10);
        const m2 = urlStr.match(/\/page\/(\d+)/i);
        if (m2) return parseInt(m2[1], 10);
        const m3 = urlStr.match(/[\/-]p(\d+)(?:[\/\.]|$)/i);
        if (m3) return parseInt(m3[1], 10);
        const m4 = urlStr.match(/(\d+)\.html?$/i);
        if (m4) return parseInt(m4[1], 10);
        return NaN;
    }

    const candidatePages = [];    // { num, href }
    const allAnchors = doc.querySelectorAll('a[href]');
    for (const a of allAnchors) {
        const href = a.getAttribute('href');
        if (!href) continue;
        const text = (a.textContent || '').trim();

        // Extract page number from link text (if pure number)
        let num = parseInt(text, 10);
        if (isNaN(num)) {
            // Extract page number from URL
            num = pageNumFromUrl(href);
        }
        if (!isNaN(num) && num >= 1 && num <= 99999) {
            candidatePages.push({ num, href });
        }
    }

    if (candidatePages.length > 0) {
        // Determine current page number from URL
        let currentNum = 1;

        // Try to find which page is "active" or "current" on the page
        const activeEl = doc.querySelector(
            '.pagination .active a, .pagination .current a, .pagination a.active, .pagination a.current, ' +
            '.pager .active a, .pager .current a, ' +
            'a.active, a.current, ' +
            'span.page-numbers.current, .page-numbers.current, ' +
            'span.current, a.page-link.active, a.page-link.current, ' +
            'span.page-link, ' +
            '[aria-current="page"] a, [aria-current="page"]'
        );
        if (activeEl) {
            const activeHref = activeEl.getAttribute('href') || activeEl.closest('a')?.getAttribute('href') || '';
            if (activeHref) {
                const n = pageNumFromUrl(activeHref);
                if (!isNaN(n)) currentNum = n;
            } else {
                const n2 = parseInt((activeEl.textContent || '').trim(), 10);
                if (!isNaN(n2)) currentNum = n2;
            }
        } else {
            const urlMatch = currentUrl.match(/[?&](?:page|pagenumber|page_num|page_number|pageNo|pageIndex|pageindex|pg|pn)=\d+/i);
            if (urlMatch) {
                currentNum = parseInt(urlMatch[0].match(/\d+/)[0], 10);
            } else {
                const urlMatch2 = currentUrl.match(/\/page\/(\d+)/i);
                if (urlMatch2) {
                    currentNum = parseInt(urlMatch2[1], 10);
                } else {
                    const urlMatch3 = currentUrl.match(/[\/-]p(\d+)(?:[\/\.]|$)/i);
                    if (urlMatch3) {
                        currentNum = parseInt(urlMatch3[1], 10);
                    }
                }
            }
        }

        // Find the link for currentPage + 1
        const nextTarget = candidatePages.find(c => c.num === currentNum + 1);
        if (nextTarget) {
            const url = resolveUrl(nextTarget.href, currentUrl);
            if (url && url !== currentUrl) return url;
        }

        // Fallback: any link with a number larger than current
        const larger = candidatePages.filter(c => c.num > currentNum).sort((a, b) => a.num - b.num);
        if (larger.length > 0) {
            const url = resolveUrl(larger[0].href, currentUrl);
            if (url && url !== currentUrl) return url;
        }
    }

    // ── Strategy 6: URL pattern inference (blind increment) ────────────
    // If the URL has a page-number pattern, try the next one directly.
    const urlInc = (function tryInferNext(url) {
        const m = url.match(/^((.*?[?&](?:page|pagenumber|page_num|page_number|pageNo|pageIndex|pageindex|pg|pn)=)(\d+)(.*))$/i);
        if (m) return m[2] + (parseInt(m[3], 10) + 1) + (m[4] || '');
        const m2 = url.match(/^((.*?\/page\/)(\d+)(.*))$/i);
        if (m2) return m2[2] + (parseInt(m2[3], 10) + 1) + (m2[4] || '');
        const m3 = url.match(/^((.*?[\/-])p(\d+)([\/\.].*))$/i);
        if (m3) return m3[2] + 'p' + (parseInt(m3[3], 10) + 1) + (m3[4] || '');
        return null;
    })(currentUrl);
    if (urlInc && urlInc !== currentUrl) {
        // Only use this as a last resort — we'll try it and the fetch will 404 if wrong
        return urlInc;
    }

    return null;
}

// ─── Paginated Content Extraction ───────────────────────────────────────────
// Normalize whitespace for content comparison (dedup)
function normalizeWhitespace(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
}

async function extractWithPagination(html, url) {
    const page = await extractFromHtml(html, url);
    if (!page) return null;

    const allContent = [page.content];
    let currentUrl = url;
    let currentHtml = html;
    let pageCount = 1;
    const fetchedUrls = new Set([url]);   // track visited URLs to prevent loops

    while (pageCount < MAX_PAGINATION_PAGES) {
        const nextUrl = findNextPageUrl(currentHtml, currentUrl);
        if (!nextUrl || nextUrl === currentUrl) break;

        // Skip URLs we've already seen (prevents loops from URL inference)
        if (fetchedUrls.has(nextUrl)) break;
        fetchedUrls.add(nextUrl);

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), PAGINATION_TIMEOUT_MS);
            const resp = await fetch(nextUrl, {
                signal: controller.signal,
                credentials: 'include',          // send cookies for same-origin auth
            });
            clearTimeout(timeoutId);

            if (!resp.ok) break;

            const nextHtml = await resp.text();
            const nextPage = await extractFromHtml(nextHtml, nextUrl);
            if (!nextPage || !nextPage.content) break;

            // Dedup: if the new content is identical to the last page, stop
            const lastContent = allContent[allContent.length - 1];
            if (normalizeWhitespace(nextPage.content) === normalizeWhitespace(lastContent)) break;

            allContent.push(nextPage.content);
            currentUrl = nextUrl;
            currentHtml = nextHtml;
            pageCount++;
        } catch {
            break;  // network error or timeout — stop pagination gracefully
        }
    }

    if (pageCount > 1) {
        page.content = allContent.join('\n<!-- pagination-break -->\n');
    }
    return page;
}

function initSanitize(includeImages) {
    const san = getSanitizeHtmlOptions()
    san.allowedAttributes.img = ['src', 'alt', 'title']
    if (!includeImages) {
        // getSanitizeHtmlOptions returns a shallow clone whose allowedTags array
        // is shared with the module default; repeated calls must not splice -1.
        const imgIdx = san.allowedTags.indexOf('img')
        if (imgIdx > -1) {
            san.allowedTags.splice(imgIdx, 1)
        }
        const picIdx = san.allowedTags.indexOf('picture')
        if (picIdx > -1) {
            san.allowedTags.splice(picIdx, 1)
        }
    }
    setSanitizeHtmlOptions(san)
}

const template = {
    ['META-INF/container.xml']: function () {
        return `<?xml version="1.0" encoding="UTF-8" ?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>`
    },

    ['OEBPS/content.opf']: function (book, images) {
        return `<?xml version="1.0"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
        <dc:title>${book.title}</dc:title>
        <dc:language>${book.language}</dc:language>
        <dc:identifier id="BookId" opf:scheme="uuid">${book.id}</dc:identifier>
        <dc:creator opf:file-as="" opf:role="aut">EpubPressX</dc:creator>
        <meta name="cover" content="cover"/>
    </metadata>
    <manifest>
${book.pages.map((page, index) => `        <item id="chapter${index + 1}" href="chapter${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}
        <item id="references" href="references.xhtml" media-type="application/xhtml+xml"/>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${images.map(image => `        <item id="${image.id}" href="${image.path}" media-type="${image.type}"/>`).join('\n')}
    </manifest>
    <spine toc="ncx">
${book.pages.map((page, index) => `        <itemref idref="chapter${index + 1}" />`).join('\n')}
        <itemref idref="references" />
    </spine>
</package>`
    },

    ['OEBPS/toc.ncx']: function (book) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<ncx version="2005-1" xml:lang="${book.language}" xmlns="http://www.daisy.org/z3986/2005/ncx/">
    <head>
        <meta name="dtb:uid" content="${book.id}"/> <!-- same as in .opf -->
        <meta name="dtb:depth" content="1"/> <!-- 1 or higher -->
        <meta name="dtb:totalPageCount" content="0"/> <!-- must be 0 -->
        <meta name="dtb:maxPageNumber" content="0"/> <!-- must be 0 -->
    </head>
    <docTitle>
        <text>${book.title}</text>
    </docTitle>
    <docAuthor>
        <text>EpubPressX</text>
    </docAuthor>
    <navMap>
${book.pages.map((page, index) => `        <navPoint id="chapter${index + 1}" playOrder="${index + 1}">
            <navLabel><text>${page.title}</text></navLabel>
            <content src="chapter${index + 1}.xhtml"/>
        </navPoint>`).join('\n')}
        <navPoint id="references" playOrder="${book.pages.length + 1}">
            <navLabel><text>References</text></navLabel>
            <content src="references.xhtml"/>
        </navPoint>
    </navMap>
</ncx>`
    },

    chapter: function (title, content, language) {
        const languageAttributes = language ? ` lang="${language}" xml:lang="${language}"` : '';
        return `<?xml version="1.0" encoding="UTF-8" ?>
<html xmlns="http://www.w3.org/1999/xhtml"${languageAttributes}>
    <head>
        <title>${title}</title>
        <style>
            body {
                font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji";
                word-break: break-word;
                hyphens: auto;
                text-align: justify;
                line-height: 1.75em;
                letter-spacing: 0.5px;
            }
            p, section {
                display: block;
                margin-block-start: 1em;
                margin-block-end: 1em;
                margin-inline-start: 0px;
                margin-inline-end: 0px;
                unicode-bidi: isolate;
            }
        </style>
    </head>
    <body>
        <h2>${title}</h2>
        ${content}
    </body>
</html>`
    },

    references: function (book) {
        return `<?xml version="1.0" encoding="UTF-8" ?>
<html xmlns="http://www.w3.org/1999/xhtml">
    <head>
        <title>References</title>
        <style>
            li {
                word-break: break-all;
            }
        </style>
    </head>
    <body>
        <h2>References</h2>
        <ol>
${book.pages.map((page) => `            <li><a href="${htmlEncode(page.url)}">${htmlEncode(page.title)} (${htmlEncode(page.url)})</a></li>`).join('\n')}
        </ol>
    </body>
</html>`
    }
}

function htmlEncode(input = '') {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
}

function normalizeLanguageTag(language = '') {
    const normalized = language.trim().replace(/_/g, '-');
    if (!normalized) {
        return '';
    }

    const parts = normalized.split('-').filter(Boolean);
    if (parts.length === 0) {
        return '';
    }

    return parts
        .map((part, index) => {
            if (index === 0) {
                return part.toLowerCase();
            }
            if (part.length === 2) {
                return part.toUpperCase();
            }
            return part.toLowerCase();
        })
        .join('-');
}

function extractLanguageFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const htmlLang = doc.documentElement?.getAttribute('lang') || '';
    if (htmlLang) {
        return normalizeLanguageTag(htmlLang);
    }

    const selectors = [
        'meta[http-equiv="content-language"]',
        'meta[name="content-language"]',
        'meta[name="language"]',
        'meta[property="language"]',
        'meta[name="dc.language"]',
        'meta[property="dc.language"]',
        'meta[name="dcterms.language"]',
        'meta[property="og:locale"]',
    ];

    for (const selector of selectors) {
        const content = doc.querySelector(selector)?.getAttribute('content') || '';
        const language = normalizeLanguageTag(content.split(',')[0].trim());
        if (language) {
            return language;
        }
    }

    const scripts = Array.from(doc.querySelectorAll('script'));
    for (const script of scripts) {
        const content = script.textContent || '';
        const match = content.match(/window\.LANG\s*=\s*['"]([^'"]+)['"]/);
        const language = normalizeLanguageTag(match?.[1] || '');
        if (language) {
            return language;
        }
    }

    const elementLang = doc.querySelector('body[lang], article[lang], main[lang], [lang]')?.getAttribute('lang') || '';
    if (elementLang) {
        return normalizeLanguageTag(elementLang);
    }

    return '';
}

// replace images in html with local path
function replaceImages(html, images) {
    const srcPathMap = {};
    for (const image of images) {
        srcPathMap[image.src] = image.path;
    }

    const dom = new DOMParser().parseFromString(html, 'text/xml');
    const pageImages = dom.querySelectorAll('img');
    pageImages.forEach((image) => {    
        const src = image.src;
        if (srcPathMap[src]) {
            image.src = srcPathMap[src];
        }
    })

    // remove <source> tag, because it's not supported in epub
    const sources = dom.querySelectorAll('source');
    sources.forEach(source => {
        source.remove();
    });

    return new XMLSerializer().serializeToString(dom);
}

function downloadImages(images) {
    const extensionTypeMap = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        bmp: 'image/bmp',
        avif: 'image/avif',
    };

    const getTypeFromUrl = (src = '') => {
        const cleanUrl = src.split('?')[0].split('#')[0];
        const extension = cleanUrl.split('.').pop()?.toLowerCase() || '';
        return extensionTypeMap[extension] || '';
    };

    const promises = images.map(async (image) => {
        try {
            const res = await fetch(image.src);
            if (!res.ok) {
                throw new Error(`Image download failed with status ${res.status}`);
            }

            const blob = await res.blob();
            const contentType = (res.headers.get('Content-Type') || blob.type || getTypeFromUrl(image.src) || '').split(';')[0].trim();

            if (!contentType) {
                throw new Error('Missing image content type');
            }

            image.type = contentType;
            image.blob = blob;
        } catch (error) {
            console.error(`Skipping image download: ${image.src}`, error);
            image.type = null;
            image.blob = null;
        }
    });

    return Promise.all(promises)
}

// ─── Auto-Generated Table of Contents ─────────────────────────────────────────
// Scan extracted content for headings (h1-h4), add anchor IDs, and build a TOC page.

function buildTocFromPages(pages) {
    const entries = [];  // { level, text, id, pageIdx }
    let headingCount = 0;

    pages.forEach((page, pageIdx) => {
        let debug = { pageIdx, contentLen: page.content?.length, pCount: 0, hCount: 0, matched: false, err: null };
        try {
            const dom = new DOMParser().parseFromString(page.content, 'text/html');
            const body = dom.body;
            if (!body) { console.log('[TOC] no body', debug); return; }

            // ── Strategy A: explicit heading tags (h1-h4) ──────────────
            const headings = body.querySelectorAll('h1, h2, h3, h4');
            debug.hCount = headings.length;
            headings.forEach(h => {
                const text = (h.textContent || '').trim();
                if (!text) return;
                const id = `toc-h-${headingCount}`;
                h.setAttribute('id', id);
                entries.push({
                    level: parseInt(h.tagName[1], 10),
                    text,
                    id,
                    pageIdx,
                });
                headingCount++;
            });

            // ── Strategy B: implicit headings inside <p> tags ───────────
            const paras = body.querySelectorAll('p');
            debug.pCount = paras.length;
            paras.forEach(p => {
                const fullText = (p.textContent || '').trim();
                if (!fullText) return;
                if (p.querySelector('h1, h2, h3, h4')) return;

                let titleText = '';
                let isHeading = false;

                if (/^第[一二三四五六七八九十零〇百千万\d]+[章节回篇部集]/.test(fullText)) {
                    const html = p.innerHTML;
                    const brIdx = html.indexOf('<br>');
                    if (brIdx > 0) {
                        const beforeBr = html.substring(0, brIdx);
                        const tempDoc = new DOMParser().parseFromString(beforeBr, 'text/html');
                        titleText = (tempDoc.body.textContent || '').trim();
                    } else {
                        titleText = fullText;
                    }
                    if (titleText) {
                        isHeading = true;
                        debug.matched = true;
                        debug.matchText = titleText.substring(0, 30);
                    }
                }

                if (isHeading && titleText) {
                    const id = `toc-h-${headingCount}`;
                    p.setAttribute('id', id);
                    entries.push({
                        level: 1,
                        text: titleText,
                        id,
                        pageIdx,
                    });
                    headingCount++;
                }
            });

            // Serialize back
            const serializer = new XMLSerializer();
            let html = serializer.serializeToString(body);
            html = html.replace(/^<body[^>]*>/, '').replace(/<\/body>$/, '');
            page.content = html;
        } catch (e) {
            debug.err = e.message;
            console.log('[TOC] error', debug);
        }
        console.log('[TOC] debug', JSON.stringify(debug));
    });

    return entries;
}

function generateTocHtml(entries) {
    if (entries.length === 0) return '';

    let html = `<nav epub:type="toc">
<ul>
`;
    for (const entry of entries) {
        // After TOC prepend, original page 0 becomes chapter 2 (index + 2)
        const chapterIdx = entry.pageIdx + 2;
        const href = `chapter${chapterIdx}.xhtml#${entry.id}`;
        const margin = (entry.level - 1) * 1.5;
        html += `  <li style="margin-left:${margin}em"><a href="${htmlEncode(href)}">${htmlEncode(entry.text)}</a></li>\n`;
    }
    html += `</ul>
</nav>`;

    return html;
}

async function extractPages(book) {
    initSanitize(book.includeImages)
    book.id = `book-${Date.now()}`
    book.pages = []
    const sectionLanguages = [];
    for(const section of book.sections) {
        const page = await extractWithPagination(section.html, section.url)
        if (page) {
            page.content = stripExternalLinkBlocks(page.content, page.url);
            page.language = extractLanguageFromHtml(section.html);
            if (page.language) {
                sectionLanguages.push(page.language);
            }
            book.pages.push(page)
        }
    }
    book.language = sectionLanguages[0] || 'en';
}

export async function generateEpub(book) {
    await extractPages(book);

    // ── Auto-generate Table of Contents from headings ────────────────────
    const tocEntries = buildTocFromPages(book.pages);
    if (tocEntries.length > 0) {
        const tocHtml = generateTocHtml(tocEntries);
        const tocPage = {
            title: '目录',
            content: tocHtml,
            language: book.language,
            url: book.pages[0]?.url || '',
        };
        book.pages.unshift(tocPage);
    }

    // [{ id, src, type, blob, path }]
    const images = [];
    if (book.includeImages) {
        // get all image urls
        let id = 1;
        book.pages.forEach(page => {
            const dom = new DOMParser().parseFromString(page.content, 'text/xml');
            const pageImages = dom.querySelectorAll('img');
            pageImages.forEach(img => {
                const src = img.attributes.src.value;
                if (src) {
                    images.push({ id, src });
                    id++;
                }
            });
        });
    }
    // add cover image
    const coverPath = book.coverPath?.trim() || images[0]?.src;
    if (coverPath) {
        images.push({
            id: 'cover',
            src: coverPath,
        });
    }
    await downloadImages(images);
    const validImages = images.filter(image => image.blob && image.type);
    // set images path
    validImages.forEach(image => {
        image.path = 'image/' + image.id + '.' + image.type.split('/')[1];
    });

    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('META-INF/container.xml', template['META-INF/container.xml']());
    zip.file('OEBPS/toc.ncx', template['OEBPS/toc.ncx'](book));
    book.pages.forEach((page, index) => {
        let xml = template.chapter(page.title, page.content, page.language)
        xml = replaceImages(xml, validImages);
        zip.file(`OEBPS/chapter${index + 1}.xhtml`, xml);
    })
    zip.file('OEBPS/references.xhtml', template.references(book));
    for (const image of validImages) {
        zip.file('OEBPS/' + image.path, image.blob);
    }
    zip.file('OEBPS/content.opf', template['OEBPS/content.opf'](book, validImages));
    return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' })
}

// ─── Link/URL Stripping (ad & recommendation cleanup) ───────────────────────

function getDomain(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return null;
    }
}

// CJK punctuation terminates a bare URL so no stray punctuation is left behind.
const BARE_URL_RE = /https?:\/\/[^\s"'<>\\\u3000，。；：！？、）】》」』]+/;

function stripExternalLinkBlocks(content, pageUrl) {
    const doc = new DOMParser().parseFromString(content, 'text/html');
    const pageDomain = getDomain(pageUrl);

    if (pageDomain) {
        doc.querySelectorAll('a[href]').forEach((a) => {
            const href = a.getAttribute('href');
            const linkDomain = getDomain(href);
            if (linkDomain && linkDomain !== pageDomain) {
                a.remove();
            }
        });
    }

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
    }
    textNodes.forEach((node) => {
        if (node.parentElement && node.parentElement.closest('a')) {
            return;
        }
        if (node.nodeValue) {
            const cleaned = node.nodeValue
                .replace(new RegExp(BARE_URL_RE.source, 'g'), '')
                .replace(/\s{2,}/g, ' ')
                .trim();
            if (cleaned === '') {
                node.remove();
            } else if (cleaned !== node.nodeValue) {
                node.nodeValue = cleaned;
            }
        }
    });

    return new XMLSerializer().serializeToString(doc.body)
        .replace(/^<body[^>]*>/, '').replace(/<\/body>$/, '');
}

// ─── Plain Text (TXT) Export ────────────────────────────────────────────────

const TXT_BLOCK_SELECTORS = [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote',
    'pre', 'section', 'article', 'div', 'figure', 'figcaption',
    'table', 'tr', 'td', 'th', 'header', 'footer',
].join(', ');

function htmlToPlainText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.body.querySelectorAll('br').forEach((br) => br.replaceWith(doc.createTextNode('\n')));
    doc.body.querySelectorAll(TXT_BLOCK_SELECTORS).forEach((el) => el.appendChild(doc.createTextNode('\n')));
    const lines = (doc.body.textContent || '')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim());
    return lines.filter((line) => line).join('\n\n');
}

export async function generateTxt(book) {
    await extractPages(book);
    const sections = [book.title];
    book.pages.forEach((page) => {
        const bodyText = htmlToPlainText(page.content);
        if (bodyText) {
            sections.push(`${page.title}\n\n${bodyText}`);
        }
    });
    if (book.pages.length > 0) {
        const references = book.pages
            .map((page, index) => `${index + 1}. ${page.title} (${page.url})`)
            .join('\n');
        sections.push(`References\n${references}`);
    }
    // BOM so editors on all platforms read the file as UTF-8
    const text = `\uFEFF${sections.join('\n\n\n')}\n`;
    return new Blob([text], { type: 'text/plain;charset=utf-8' });
}
