import { extractFromHtml, getSanitizeHtmlOptions, setSanitizeHtmlOptions } from '@extractus/article-extractor'
import JSZip from 'jszip';
import { encodeXml } from './escape.js';
import { detectChapterTitles, cleanChapterTitle, splitVolumeEntry } from './toc.js';

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

    // ── Stop-reason recording (observability only — no control flow change) ──
    // `null` means no explicit break ran, i.e. the while condition ended the loop.
    let stopReason = null;
    let status = null;
    let lastUrl = url;
    let error = null;

    while (pageCount < MAX_PAGINATION_PAGES) {
        const nextUrl = findNextPageUrl(currentHtml, currentUrl);
        if (!nextUrl || nextUrl === currentUrl) { stopReason = 'complete'; break; }

        // Skip URLs we've already seen (prevents loops from URL inference)
        if (fetchedUrls.has(nextUrl)) { stopReason = 'already-visited'; break; }
        fetchedUrls.add(nextUrl);

        try {
            lastUrl = nextUrl;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), PAGINATION_TIMEOUT_MS);
            const resp = await fetch(nextUrl, {
                signal: controller.signal,
                credentials: 'include',          // send cookies for same-origin auth
            });
            clearTimeout(timeoutId);
            status = resp.status;

            if (!resp.ok) { stopReason = 'http-error'; break; }

            const nextHtml = await resp.text();
            const nextPage = await extractFromHtml(nextHtml, nextUrl);
            if (!nextPage || !nextPage.content) { stopReason = 'empty-page'; break; }

            // Dedup: if the new content is identical to the last page, stop
            const lastContent = allContent[allContent.length - 1];
            if (normalizeWhitespace(nextPage.content) === normalizeWhitespace(lastContent)) { stopReason = 'duplicate-page'; break; }

            allContent.push(nextPage.content);
            currentUrl = nextUrl;
            currentHtml = nextHtml;
            pageCount++;
        } catch (err) {
            stopReason = err && err.name === 'AbortError' ? 'timeout' : 'fetch-failed';
            error = (err && err.message) || String(err);
            break;  // network error or timeout — stop pagination gracefully
        }
    }

    if (stopReason === null) stopReason = 'page-limit';

    if (pageCount > 1) {
        page.content = allContent.join('\n<!-- pagination-break -->\n');
    }
    page.pagination = { pagesMerged: pageCount, stopReason, status, lastUrl, error };
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
        <dc:title>${htmlEncode(book.title)}</dc:title>
        <dc:language>${htmlEncode(book.language)}</dc:language>
        <dc:identifier id="BookId" opf:scheme="uuid">${htmlEncode(book.id)}</dc:identifier>
        <dc:creator opf:file-as="" opf:role="aut">EpubPressX</dc:creator>
        <meta name="cover" content="cover"/>
    </metadata>
    <manifest>
${book.pages.map((page, index) => `        <item id="chapter${index + 1}" href="chapter${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}
        <item id="references" href="references.xhtml" media-type="application/xhtml+xml"/>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${images.map(image => `        <item id="${htmlEncode(image.id)}" href="${htmlEncode(image.path)}" media-type="${htmlEncode(image.type)}"/>`).join('\n')}
    </manifest>
    <spine toc="ncx">
${book.pages.map((page, index) => `        <itemref idref="chapter${index + 1}" />`).join('\n')}
        <itemref idref="references" />
    </spine>
</package>`
    },

    ['OEBPS/toc.ncx']: function (book) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<ncx version="2005-1" xml:lang="${htmlEncode(book.language)}" xmlns="http://www.daisy.org/z3986/2005/ncx/">
    <head>
        <meta name="dtb:uid" content="${htmlEncode(book.id)}"/> <!-- same as in .opf -->
        <meta name="dtb:depth" content="${book.tocNavDepth || 1}"/> <!-- levels of nested navPoints -->
        <meta name="dtb:totalPageCount" content="0"/> <!-- must be 0 -->
        <meta name="dtb:maxPageNumber" content="0"/> <!-- must be 0 -->
    </head>
    <docTitle>
        <text>${htmlEncode(book.title)}</text>
    </docTitle>
    <docAuthor>
        <text>EpubPressX</text>
    </docAuthor>
    <navMap>
${book.tocNavXml || ''}        <navPoint id="references" playOrder="${(book.tocNavCount || 0) + 1}">
            <navLabel><text>References</text></navLabel>
            <content src="references.xhtml"/>
        </navPoint>
    </navMap>
</ncx>`
    },

    chapter: function (title, content, language) {
        const languageAttributes = language ? ` lang="${htmlEncode(language)}" xml:lang="${htmlEncode(language)}"` : '';
        return `<?xml version="1.0" encoding="UTF-8" ?>
<html xmlns="http://www.w3.org/1999/xhtml"${languageAttributes}>
    <head>
        <title>${htmlEncode(title)}</title>
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
        <h2>${htmlEncode(title)}</h2>
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
${book.pages.filter((page) => !page.isToc).map((page) => `            <li><a href="${htmlEncode(page.url)}">${htmlEncode(page.title)} (${htmlEncode(page.url)})</a></li>`).join('\n')}
        </ol>
    </body>
</html>`
    }
}

function htmlEncode(input = '') {
    return encodeXml(input);
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
        const src = image.getAttribute('src');
        if (src && srcPathMap[src]) {
            image.setAttribute('src', srcPathMap[src]);
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
// Detection lives in toc.js. This section turns its flat level-tagged entries into
// a tree that both the visible TOC page and toc.ncx render from, so the reader's own
// outline panel and the in-book contents page cannot disagree.

const MAX_TOC_DEPTH = 5;

let currentVolume = null; // { key, text, childLevel }

function hostOf(url) {
    try { return new URL(url).host; } catch { return null; }
}

async function buildTocEntries(book) {
    const entries = [];
    let idOffset = 0;
    currentVolume = null;
    for (const page of book.pages) {
        const detected = detectChapterTitles(page.content, idOffset);
        idOffset += detected.entries.length;
        page.content = detected.content;

        const pageHost = hostOf(page.url);
        if (pageHost && currentVolume && currentVolume.host && pageHost !== currentVolume.host) {
            currentVolume = null; // different host → clear context
        }

        if (detected.entries.length === 0) {
            const fbText = cleanChapterTitle(page.title, book.title);
            const fbLevel = currentVolume ? currentVolume.childLevel : 0;
            entries.push({ text: fbText, level: fbLevel, id: null, page });
            if (pageHost && currentVolume) currentVolume.host = pageHost;
            continue;
        }

        detected.entries.forEach((e) => {
            const split = e.kind ? splitVolumeEntry(e.text, e.kind) : null;
            if (split) {
                if (!currentVolume || currentVolume.key !== split.volumeKey) {
                    entries.push({
                        text: split.volumeText,
                        level: 0,
                        id: e.id,
                        page,
                    });
                    currentVolume = {
                        key: split.volumeKey,
                        text: split.volumeText,
                        childLevel: e.level,
                        host: pageHost || currentVolume?.host || null,
                    };
                }
                entries.push({ text: split.chapterText, level: e.level, id: e.id, page });
            } else {
                entries.push({ text: e.text, level: e.level, id: e.id, page });
            }
        });
    }
    return entries;
}

// Only the *change* in level is meaningful: heading tags are not a shared scale
// across merged pages, because a surviving h1 gets rewritten to h2 upstream.
function buildNavTree(entries) {
    const root = { children: [] };
    const stack = [root];
    let prevLevel = null;
    let prevDepth = 0;
    entries.forEach((entry) => {
        const level = Number.isFinite(entry.level) ? Math.max(0, entry.level) : 0;
        let depth;
        if (prevLevel === null) depth = 0;
        else if (level > prevLevel) depth = prevDepth + 1;
        else if (level === prevLevel) depth = prevDepth;
        else depth = Math.max(0, prevDepth - (prevLevel - level));
        depth = Math.min(depth, MAX_TOC_DEPTH);
        prevLevel = level;
        prevDepth = depth;
        while (stack.length - 1 > depth) stack.pop();
        const node = { entry, children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
    });
    return root;
}

function navTreeDepth(node) {
    if (node.children.length === 0) return 1;
    return 1 + Math.max(...node.children.map(navTreeDepth));
}

function renderNavPoints(root, resolveFile) {
    let order = 0;
    const walk = (nodes) => nodes.map((node) => {
        order += 1;
        const src = resolveFile(node.entry) + (node.entry.id ? `#${node.entry.id}` : '');
        return `        <navPoint id="navpoint-${order}" playOrder="${order}">
            <navLabel><text>${htmlEncode(node.entry.text)}</text></navLabel>
            <content src="${htmlEncode(src)}"/>
${walk(node.children)}        </navPoint>`;
    }).join('\n');
    return { xml: root.children.length ? walk(root.children) + '\n' : '', count: order };
}

function renderTocHtml(root, resolveFile) {
    const walk = (nodes) => nodes.length
        ? `<ul>\n${nodes.map((node) => {
            const href = resolveFile(node.entry) + (node.entry.id ? `#${node.entry.id}` : '');
            return `<li><a href="${htmlEncode(href)}">${htmlEncode(node.entry.text)}</a>\n${walk(node.children)}</li>\n`;
        }).join('')}</ul>\n`
        : '';
    return `<div class="toc">\n${walk(root.children)}</div>`;
}

async function extractPages(book) {
    initSanitize(book.includeImages)
    book.id = `book-${Date.now()}`
    book.pages = []
    book.pagination = []
    const sectionLanguages = [];
    for(const [sectionIndex, section] of book.sections.entries()) {
        const page = await extractWithPagination(section.html, section.url)
        if (page) {
            page.content = stripExternalLinkBlocks(page.content, page.url);
            page.language = extractLanguageFromHtml(section.html);
            if (page.language) {
                sectionLanguages.push(page.language);
            }
            book.pages.push(page)
            book.pagination.push({
                sectionIndex,
                sectionUrl: section.url,
                title: page.title,
                ...page.pagination,
            })
        } else {
            book.pagination.push({
                sectionIndex,
                sectionUrl: section.url,
                title: null,
                pagesMerged: 0,
                stopReason: 'no-article',
                status: null,
                lastUrl: section.url,
                error: null,
            })
        }
    }
    book.language = sectionLanguages[0] || 'en';
}

export async function generateEpub(book) {
    await extractPages(book);

    // ── Auto-generate Table of Contents from headings ────────────────────
    const tocEntries = await buildTocEntries(book);
    if (tocEntries.length > 0) {
        const tocPage = {
            isToc: true,
            title: '目录',
            content: '',
            language: book.language,
            url: '',
        };
        book.pages.unshift(tocPage);
        // Resolved lazily so the file number follows the final page order
        // instead of assuming where the TOC page was inserted.
        const resolveFile = (entry) => `chapter${book.pages.indexOf(entry.page) + 1}.xhtml`;
        const navRoot = buildNavTree(tocEntries);
        const nav = renderNavPoints(navRoot, resolveFile);
        book.tocNavXml = nav.xml;
        book.tocNavCount = nav.count;
        book.tocNavDepth = Math.max(1, navTreeDepth(navRoot) - 1);
        tocPage.content = renderTocHtml(navRoot, resolveFile);
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
                const src = img.getAttribute('src');
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
            const stripped = node.nodeValue.replace(new RegExp(BARE_URL_RE.source, 'g'), '');
            if (stripped === node.nodeValue) {
                return;
            }
            const cleaned = stripped.replace(/\s{2,}/g, ' ').trim();
            if (cleaned === '') {
                node.remove();
            } else {
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
