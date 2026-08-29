import { assert } from 'chai';
import { generateEpub, generateTxt } from '../scripts/generater';

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Sample Article</title></head>
<body>
    <article>
        <h1>Sample Article</h1>
        <p>First paragraph with a <a href="https://example.com">link</a>.</p>
        <p>Second paragraph.</p>
    </article>
</body>
</html>`;

const SAMPLE_BOOK = {
    title: 'Sample Book',
    includeImages: false,
    sections: [{ url: 'https://example.com/sample', html: SAMPLE_HTML }],
};

// Long filler text so extractFromHtml's contentLengthThreshold (200) is satisfied.
const FILLER = '这是一段足够长的正文填充文字，用来确保文章内容超过提取器的最小长度阈值，从而让整个提取链路正常工作。'.repeat(4);

describe('generater', () => {
    it('exports the book as a plain text file', async () => {
        const blob = await generateTxt({ ...SAMPLE_BOOK, sections: [...SAMPLE_BOOK.sections] });
        const text = await blob.text();

        assert.match(blob.type, /text\/plain/);
        assert.include(text, 'Sample Book');
        assert.include(text, 'First paragraph');
        assert.include(text, 'Second paragraph');
        assert.include(text, 'https://example.com/sample');
        assert.notInclude(text, '<p>');
    });

    it('still exports the book as an epub file', async () => {
        const blob = await generateEpub({ ...SAMPLE_BOOK, sections: [...SAMPLE_BOOK.sections] });

        assert.match(blob.type, /application\/epub\+zip/);
        assert.isAbove(blob.size, 0);
    });
});

describe('stripExternalLinkBlocks', () => {
    const makeBook = (bodyHtml) => ({
        title: 'Clean Book',
        includeImages: false,
        sections: [{
            url: 'https://example.com/article/1',
            html: `<!DOCTYPE html>
<html lang="zh">
<head><title>Clean Article</title></head>
<body>
    <article>
        <h1>Clean Article</h1>
        ${bodyHtml}
    </article>
</body>
</html>`,
        }],
    });

    it('removes external-domain link blocks (ad/recommendation) from exported text', async () => {
        // Block-level ad links survive extraction (unlike inline <a>); must be removed.
        const body = `<p>${FILLER}</p>
            <a href="https://ads.example.net/landing"><div class="h5">广告书名</div><div>广告作者</div><div>广告简介</div></a>
            <p>之后还有正文。</p>`;
        const blob = await generateTxt(makeBook(body));
        const text = await blob.text();

        assert.notInclude(text, '广告书名', 'external ad block book title must be removed');
        assert.notInclude(text, '广告作者', 'external ad block author must be removed');
        assert.notInclude(text, '广告简介', 'external ad block blurb must be removed');
        assert.include(text, '之后还有正文', 'surrounding real text must remain');
    });

    it('removes leftover bare link text that lost its <a> tag during extraction', async () => {
        const body = `<p>${FILLER}</p>
            <p>正文 <a href="https://ads.example.net/landing">https://ads.example.net/landing</a> 之后。</p>`;
        const blob = await generateTxt(makeBook(body));
        const text = await blob.text();

        assert.notInclude(text, 'https://ads.example.net/landing', 'link text that is a URL must be removed');
        assert.include(text, '之后', 'surrounding text must remain');
    });

    it('removes bare URL strings from text', async () => {
        const body = `<p>${FILLER}</p>
            <p>正文 https://www.ibbs.pro/thread/abc?pagenumber=2 继续阅读。</p>`;
        const blob = await generateTxt(makeBook(body));
        const text = await blob.text();

        assert.notInclude(text, 'https://www.ibbs.pro/thread/abc', 'bare URL must be removed');
        assert.include(text, '继续阅读', 'text after the URL must remain');
    });

    it('removes bare URLs followed by Chinese punctuation', async () => {
        const body = `<p>${FILLER}</p>
            <p>正文 https://www.ibbs.pro/thread/abc。继续阅读。</p>`;
        const blob = await generateTxt(makeBook(body));
        const text = await blob.text();

        assert.notInclude(text, 'https://www.ibbs.pro/thread/abc', 'bare URL before 。 must be removed');
        assert.include(text, '继续阅读', 'text after the 。 must remain');
    });

    it('keeps same-domain links (in-article citations)', async () => {
        const body = `<p>${FILLER}</p>
            <p>参见 <a href="/other-page">站内引用</a> 的内容。</p>`;
        const blob = await generateTxt(makeBook(body));
        const text = await blob.text();

        assert.include(text, '站内引用', 'same-domain link text must be kept');
    });

    it('keeps the article title', async () => {
        const body = `<p>${FILLER}</p>`;
        const blob = await generateTxt(makeBook(body));
        const text = await blob.text();

        assert.include(text, 'Clean Article', 'article title must be preserved');
    });

    it('keeps the pagination marker intact and still cleans content around it', async () => {
        const body = `<p>${FILLER}</p>
            <p>正文 <a href="https://ads.example.net/x">广告文字</a></p>
            <!-- pagination-break -->
            <p>下一页正文。</p>`;
        const blob = await generateTxt(makeBook(body));
        const text = await blob.text();

        assert.notInclude(text, '广告文字', 'ad text removed despite pagination marker');
        assert.include(text, '下一页正文', 'content after the marker remains');
    });
});
