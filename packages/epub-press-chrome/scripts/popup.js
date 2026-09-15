import $ from 'jquery';

import Browser from './browser';
import UI from './ui';
import { generateEpub, generateTxt } from './generater';

/*
i18n
*/
$('#text-mobile').text(chrome.i18n.getMessage('textMobile'));
$('#text-title').text(chrome.i18n.getMessage('textTitle'));
$('#auto-gen-title title').text(chrome.i18n.getMessage('textAutoGenTitle'));
// text-cover
$('#text-cover').text(chrome.i18n.getMessage('textCover'));
// text-include-images
$('#text-include-images').text(chrome.i18n.getMessage('textIncludeImages'));
// text-format
$('#text-format').text(chrome.i18n.getMessage('textFormat'));
// text-select-pages
$('#text-select-pages').text(chrome.i18n.getMessage('textSelectPages'));
// text-select-all
$('#select-all').text(chrome.i18n.getMessage('textSelectAll'));
// text-select-none
$('#select-none').text(chrome.i18n.getMessage('textSelectNone'));
// text-download
$('#download').text(chrome.i18n.getMessage('textDownload'));

/*
Download Form
*/

// auto generate title, base on first checked item
async function autoGenTitle() {
    const firstChecked = $('input.article-checkbox:checked')[0];
    if (firstChecked) {
        $('#text-title-container').addClass('loading');
        try {
            const title = firstChecked.nextElementSibling.textContent;
            // request server
            const response = await fetch(`http://api-title-short.link2epub.com/?text=${encodeURIComponent(title)}`);
            const text = await response.text();
            $('#book-title').val(text);
        } catch (error) {
            console.error('Error:', error);
        } finally {
            $('#text-title-container').removeClass('loading');
        }
    }
}

/**
 * replace all Mac & Windows not supported characters to '_'
 * limit max length
 */
function sanitizeFilename(filename) {
    return filename
        .trim()
        .replace(/[/\\?%*:|"<>]/g, '_') // Replace not supported characters
        .replace(/\.\./g, '_') // Replace double dots to avoid navigation confusion
        .replace(/\.+$/, '') // Remove trailing periods
        .substring(0, 100);
}

function useFirstCheckedTitle() {
    const firstChecked = $('input.article-checkbox:checked')[0];
    if (firstChecked) {
        const title = firstChecked.nextElementSibling.textContent;
        $('#book-title').val(sanitizeFilename(title));
    }
}

$('#gen-icon').on('click', () => {
    autoGenTitle();
});

function updateSelectedCount() {
    const selectedCount = $('input.article-checkbox:checked').length;
    if (selectedCount > 0) {
        $('#text-title-container').addClass('selected');
    } else {
        $('#text-title-container').removeClass('selected');
    }
    if (selectedCount === 1) {
        useFirstCheckedTitle();
    }
}

$('#tab-list').on('change', 'input.article-checkbox', () => {
    updateSelectedCount();
});

$('#select-all').click(() => {
    $('input.article-checkbox').each((index, checkbox) => {
        $(checkbox).prop('checked', true);
    });
    updateSelectedCount();
});

$('#select-none').click(() => {
    $('input.article-checkbox').each((index, checkbox) => {
        $(checkbox).prop('checked', false);
    });
    updateSelectedCount();
});

const PAGINATION_STOP_REASON_KEYS = {
    complete: 'textPaginationStopComplete',
    'page-limit': 'textPaginationStopPageLimit',
    'already-visited': 'textPaginationStopAlreadyVisited',
    'http-error': 'textPaginationStopHttpError',
    'empty-page': 'textPaginationStopEmptyPage',
    'duplicate-page': 'textPaginationStopDuplicatePage',
    'fetch-failed': 'textPaginationStopFetchFailed',
    'no-article': 'textPaginationStopNoArticle',
    timeout: 'textPaginationStopTimeout',
};

/**
 * One localized line describing the pagination outcome recorded on
 * book.pagination while the book was generated.
 */
function renderPaginationSummary(book) {
    const entries = book.pagination;
    const stopped = entries.find((entry) => entry.stopReason !== 'complete');
    if (stopped) {
        const reasonKey = PAGINATION_STOP_REASON_KEYS[stopped.stopReason];
        const reason = reasonKey ? chrome.i18n.getMessage(reasonKey) : stopped.stopReason;
        return chrome.i18n.getMessage('textPaginationSummaryStopped', [
            String(stopped.title || stopped.sectionUrl),
            String(stopped.pagesMerged),
            String(reason),
        ]);
    }
    const pages = entries.reduce((sum, entry) => sum + entry.pagesMerged, 0);
    return chrome.i18n.getMessage('textPaginationSummaryAll', [String(pages), String(entries.length)]);
}

$('#download').click(() => {
    const selectedItems = [];
    $('input.article-checkbox').each((index, checkbox) => {
        if ($(checkbox).prop('checked')) {
            selectedItems.push({
                url: $(checkbox).prop('value'),
                id: Number($(checkbox).prop('name')),
            });
        }
    });


    const FORMATS = {
        epub: generateEpub,
        txt: generateTxt,
    };
    const format = FORMATS[$('#book-format').val()] ? $('#book-format').val() : 'epub';

    if (selectedItems.length <= 0) {
        $('#alert-message').text(chrome.i18n.getMessage('textNoItems'));
    } else {
        Browser.getTabsHtml(selectedItems).then((sections) => {
            UI.showSection('#downloadSpinner');
            const book = {
                title: sanitizeFilename($('#book-title').val()) || $('#book-title').attr('placeholder'),
                coverPath: $('#book-cover').val() || undefined,
                includeImages: $('#include-images').prop('checked'),
                sections,
            };
            FORMATS[format](book).then(async (blob) => {
                UI.setPaginationSummary(renderPaginationSummary(book));
                const url = await Browser.blobToDataUrl(blob);
                chrome.downloads.download({
                    url,
                    filename: `${book.title}.${format}`,
                }, (downloadId) => {
                    if (chrome.runtime.lastError) {
                        UI.setErrorMessage(`Download failed: ${chrome.runtime.lastError.message}`);
                    } else if (downloadId === undefined) {
                        UI.setErrorMessage('Download failed: no download id returned');
                    } else {
                        UI.showSection('#downloadSuccess');
                    }
                });
            }).catch((error) => {
                UI.setErrorMessage(chrome.i18n.getMessage('textGenerateFailed', [String(error)]));
                UI.showSection('#downloadFailed');
            });
        }).catch((error) => {
            UI.setErrorMessage(`Could not find tab content: ${error}`);
        });
    }
});

/*
Messaging
*/

Browser.onBackgroundMessage((request) => {
    if (request.action === 'download') {
        if (request.status === 'complete') {
            UI.updateStatus(100, 'Done!').then(() => {
                UI.showSection('#downloadSuccess');
            });
        } else {
            UI.showSection('#downloadFailed');
            if (request.error) {
                UI.setErrorMessage(request.error);
            }
        }
    } else if (request.action === 'publish') {
        UI.updateStatus(request.progress, request.message);
    }
});

/*
Startup
*/

window.onload = () => {
    UI.initializeUi();
    UI.showSection('#downloadForm');
    UI.initializeTabList();
};
