// Chapter-title detection for the generated table of contents.
//
// Kept separate from generater.js so it can be unit-tested, and deliberately
// scoring-based: clipped pages put the chapter title in whatever place the site
// felt like (an h1, the first line of one giant <p> full of <br>, a short <p>),
// so a per-site regex list can never converge.
import { encodeXml } from './escape.js';

const CN_DIGIT = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
    '七': 7, '八': 8, '九': 9, '两': 2, '壹': 1, '贰': 2, '叁': 3, '肆': 4,
    '伍': 5, '陆': 6, '柒': 7, '捌': 8, '玖': 9,
};
const CN_UNIT = { '十': 10, '百': 100, '千': 1000, '拾': 10, '佰': 100, '仟': 1000 };
const CN_CHARS = '零〇一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟';

// 十三 -> 13, 一百二十三 -> 123, 31 -> 31
export function parseOrdinal(token) {
    const s = (token || '').trim();
    if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
    let total = 0, current = 0;
    for (const ch of s) {
        if (CN_DIGIT[ch] !== undefined) {
            current = CN_DIGIT[ch];
        } else if (CN_UNIT[ch] !== undefined) {
            total += (current === 0 ? 1 : current) * CN_UNIT[ch];
            current = 0;
        } else {
            return NaN;
        }
    }
    return total + current;
}

const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
function romanToNum(s) {
    const str = s.toLowerCase();
    if (!/^[ivxlcdm]+$/.test(str)) return NaN;
    let total = 0;
    for (let i = 0; i < str.length; i++) {
        const v = ROMAN[str[i]];
        total += v < (ROMAN[str[i + 1]] || 0) ? -v : v;
    }
    return total;
}

// Numbered-unit rank: globally comparable across merged tabs, unlike heading tags
// (Readability rewrites a surviving h1 into h2, so tag numbers are not a scale).
const UNIT_LEVEL = { '卷': 0, '部': 0, '辑': 0, '篇': 1, '章': 1, '回': 2, '节': 3 };

const SEQ_RE = new RegExp(`第\\s*([0-9]+|[${CN_CHARS}]+)\\s*([卷部辑篇章回节])`, 'g');
const LATIN_RE = new RegExp(`^\\s*(chapter|part|section|book|canto|volume|vol)\\.?\\s+([0-9]+|[ivxlcdm]+)\\b`, 'i');
const NUMBER_RE = /^\s*([0-9]{1,4})\s*[、.．:：]\s*\S/;
const CN_NUMBER_RE = new RegExp(`^\\s*([${CN_CHARS}]{1,6})\\s*[、.．:：]\\s*\\S`);
// Whole-line part labels that carry no ordinal but are still chapter headings.
const VOCAB_RE = /^\s*(序章|序言|楔子|引子|前言|尾声|后记|後記|终章|終章|大結局|大结局|番外(?:[一二三四五六七八九十\d]+)?|附錄|附录|prologue|epilogue|afterword|introduction)\s*[、.．:：]?\s*$/i;

const NOISE_RE = /发表于|发布于|更新于|举报|回复|点赞|收藏|分享|广告|下载|下一页|上一页|下一章|上一章|返回目录|加入书签|本章未完|未经允许|copyright|http:|www\.|\.com|\.net/i;
const SENTENCE_END_RE = /[。！？；，、…”』】）)】]$/;

const MAX_ENTRIES_PER_PAGE = 500;
const TITLE_MAX_LEN = 40;

function normalize(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
}

// Classify one candidate line. Returns null when it carries no ordinal at all.
function classify(text) {
    const t = normalize(text);
    if (!t) return null;

    let units = [], ordinals = [];
    SEQ_RE.lastIndex = 0;
    let m;
    while ((m = SEQ_RE.exec(t)) !== null) {
        units.push(m[2]);
        ordinals.push(parseOrdinal(m[1]));
    }
    if (units.length) {
        return {
            kind: 'seq:' + units.join(''),
            level: UNIT_LEVEL[units[units.length - 1]],
            ordinal: ordinals[ordinals.length - 1],
        };
    }
    const latin = LATIN_RE.exec(t);
    if (latin) {
        return { kind: 'latin:' + latin[1].toLowerCase(), level: 1, ordinal: parseOrdinal(latin[2]) || romanToNum(latin[2]) };
    }
    const vocab = VOCAB_RE.exec(t);
    if (vocab) return { kind: 'vocab', level: 1, ordinal: NaN };
    const num = NUMBER_RE.exec(t) || CN_NUMBER_RE.exec(t);
    if (num) {
        return { kind: 'number', level: 1, ordinal: parseOrdinal(num[1]) };
    }
    return null;
}

function firstLine(el) {
    let out = '';
    for (const node of Array.from(el.childNodes)) {
        if (node.nodeName === 'BR') break;
        if (node.nodeType === 3 || node.nodeType === 1) out += node.textContent;
    }
    const line = normalize(out);
    return line || normalize((el.textContent || '').split('\n')[0]);
}

function hasDirectBr(el) {
    return Array.from(el.childNodes).some((n) => n.nodeName === 'BR');
}

function nextBlock(el) {
    const parent = el.parentElement;
    if (!parent) return null;
    const kids = Array.from(parent.children);
    let i = kids.indexOf(el) + 1;
    while (i < kids.length && !normalize(kids[i].textContent)) i++;
    return kids[i] || null;
}

function collectCandidates(body) {
    const out = [];
    body.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
        out.push({ el: h, text: normalize(h.textContent), mode: 'heading', tag: h.tagName, seen: false });
    });
    body.querySelectorAll('p, div, td, li, font, section').forEach((block) => {
        if (block.closest && block.closest('h1,h2,h3,h4,h5,h6')) return;
        const full = normalize(block.textContent);
        if (!full) return;
        if (hasDirectBr(block)) {
            out.push({
                el: block,
                text: firstLine(block),
                mode: 'firstLine',
                brCount: Array.from(block.childNodes).filter((n) => n.nodeName === 'BR').length,
                tag: block.tagName,
            });
            return;
        }
        if (full.length <= TITLE_MAX_LEN) {
            const next = nextBlock(block);
            const nextLen = next ? normalize(next.textContent).length : 0;
            out.push({
                el: block,
                text: full,
                mode: 'shortBlock',
                followedByLong: nextLen >= 80 && nextLen >= full.length * 4,
                tag: block.tagName,
            });
        }
    });
    return out.filter((c) => c.text);
}

function score(cand, groupSize) {
    let score = 0;
    if (cand.mode === 'heading') score += 3;
    if (cand.info) score += 2;
    if (cand.followedByLong) score += 2;
    if (cand.mode === 'firstLine') {
        if (cand.text.length <= TITLE_MAX_LEN && cand.brCount >= 2) score += 2;
    }
    if (cand.mode === 'shortBlock') score += 1;
    if (groupSize >= 2) score += 3;
    return score;
}

// Group by ordinal shape so that "13 sibling title lines" outweighs any single
// clever regex: repetition with an increasing counter is the one signal that
// does not depend on knowing the site.
function applyRecurrence(cands) {
    const groups = new Map();
    cands.forEach((c) => {
        if (!c.info) return;
        const list = groups.get(c.info.kind) || [];
        list.push(c);
        groups.set(c.info.kind, list);
    });
    groups.forEach((list) => {
        let increasing = 0;
        for (let i = 1; i < list.length; i++) {
            if (list[i].info.ordinal > list[i - 1].info.ordinal) increasing++;
        }
        const size = list.length >= 2 && increasing >= 1 ? list.length : 1;
        list.forEach((c) => { c.groupSize = size; });
    });
    return cands;
}

export function detectChapterTitles(contentHtml, idOffset = 0) {
    const dom = new DOMParser().parseFromString(contentHtml || '', 'text/html');
    const body = dom.body;
    if (!body) return { entries: [], content: contentHtml || '' };

    let cands = collectCandidates(body).map((c) => {
        c.info = classify(c.text);
        c.groupSize = 1;
        return c;
    });
    cands = applyRecurrence(cands);

    const taken = new Set();
    const picked = cands
        .filter((c) => !NOISE_RE.test(c.text))
        .filter((c) => c.info || c.mode === 'heading')
        .filter((c) => {
            const min = c.mode === 'heading' ? 3 : 4;
            return score(c, c.groupSize) >= min;
        })
        .filter((c) => !(c.mode !== 'heading' && SENTENCE_END_RE.test(c.text)))
        .filter((c) => {
            // one entry per element, and never nest a title inside a chosen ancestor
            const el = c.el;
            if (taken.has(el)) return false;
            for (const other of taken) {
                if (other.contains(el) || el.contains(other)) return false;
            }
            taken.add(el);
            return true;
        })
        .slice(0, MAX_ENTRIES_PER_PAGE);

    let counter = idOffset;
    const entries = picked.map((c) => {
        const id = c.el.getAttribute('id') || `toc-h-${counter}`;
        if (!c.el.getAttribute('id')) c.el.setAttribute('id', `toc-h-${counter}`);
        counter++;
        return {
            text: c.text,
            level: c.info ? c.info.level : Math.max(0, (parseInt(c.tag[1], 10) || 2) - 2),
            id,
        };
    });

    const serialized = new XMLSerializer().serializeToString(body)
        .replace(/^<body[^>]*>/, '')
        .replace(/<\/body>$/, '');
    return { entries, content: serialized };
}

const SEPARATORS = [' - ', ' — ', ' _ ', ' | ', ' :: ', ' » ', '－', '——'];

// Extracted titles are usually "<chapter> - <book> | <site>". Strip the trailing
// part only when it is provably decoration: it repeats the book title the user
// typed, or the head already looks like a standalone chapter heading.
export function cleanChapterTitle(text, bookTitle) {
    const t = normalize(text);
    if (!t) return t;
    const head = (s) => normalize(s.split(/[。！？]/)[0]);

    for (const sep of SEPARATORS) {
        const i = t.indexOf(sep);
        if (i <= 0) continue;
        const first = t.slice(0, i).trim();
        const rest = t.slice(i + sep.length).trim();
        const decorated = (bookTitle && normalize(rest).includes(normalize(bookTitle)))
            || /^[^第0-9]{0,3}(Chapter|卷|部|篇)/i.test(rest)
            || rest.length > first.length * 1.5;
        const firstStandsAlone = !!classify(first) || first.length <= 24;
        if (decorated && firstStandsAlone) return head(first);
    }
    if (bookTitle) {
        const bt = normalize(bookTitle);
        if (bt && t.includes(bt)) {
            const stripped = normalize(t.replace(bt, ' ')).replace(/^[-—_:：|·、\s]+|[-—_:：|·、\s]+$/g, '');
            if (stripped) return stripped.length > 60 ? normalize(stripped.slice(0, 60)) : stripped;
        }
    }
    return t.length > 60 ? normalize(t.slice(0, 60)) : t;
}

export { encodeXml };
