import dayjs from 'dayjs';
import Browser from './browser';

class UI {
    static initializeUi() {
        const date = dayjs().format('YYYY-M-D');
        document.getElementById('book-title').placeholder = `EpubPressX ${date}`;
        UI.initializeOverflowMask();
    }

    static setErrorMessage(msg) {
        $('#failure-message').text(msg);
    }

    static showSection(section) {
        UI.SECTIONS_SELECTORS.forEach((selector) => {
            if (selector === section) {
                $(selector).show();
            } else {
                $(selector).hide();
            }
        });
        UI.scheduleOverflowMaskSync();
    }

    static setAlertMessage(message) {
        $('#alert-message').text(message);
    }

    static updateStatus(progress, message) {
        $('h4#progress-msg').text(message);
        if (progress) {
            return this.animateValueChange($('progress'), progress);
        }
        return Promise.resolve();
    }

    static animateValueChange($el, finalValue) {
        return new Promise((resolve) => {
            const animateFrom = (currentValue) => {
                requestAnimationFrame(() => {
                    if (currentValue === finalValue) {
                        setTimeout(resolve, 100);
                        return;
                    }
                    const diff = currentValue < finalValue ? 1 : -1;
                    const newValue = diff + currentValue;
                    $el.val(newValue);
                    animateFrom(newValue);
                });
            };
            animateFrom($el.val());
        });
    }

    static getCheckbox(props) {
        const html = `<div class="checkbox">
        <label>
        <input class='article-checkbox' type="checkbox" value="${props.url}" name="${props.id}">
        <span>${props.title}</span>
        </label>
        </div>`;
        return html;
    }

    static initializeTabList() {
        Browser.getCurrentWindowTabs().then((tabs) => {
            tabs.forEach((tab) => {
                $('#tab-list').append(UI.getCheckbox({
                    title: tab.title,
                    url: tab.url,
                    id: tab.id,
                }));
            });
            UI.scheduleOverflowMaskSync();
        }).catch((error) => {
            UI.setErrorMessage(`Searching tabs failed: ${error}`);
        });
    }

    static initializeOverflowMask() {
        if (UI.overflowMaskInitialized) {
            UI.scheduleOverflowMaskSync();
            return;
        }

        UI.overflowMaskInitialized = true;

        const syncMask = () => UI.syncOverflowMask();
        window.addEventListener('resize', syncMask);
        window.addEventListener('scroll', syncMask, { passive: true });
        document.getElementById('scroll-to-bottom').addEventListener('click', () => {
            UI.scrollToBottom();
        });

        if (typeof MutationObserver !== 'undefined') {
            UI.overflowMaskObserver = new MutationObserver(() => {
                UI.scheduleOverflowMaskSync();
            });
            UI.overflowMaskObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            });
        }

        UI.scheduleOverflowMaskSync();
    }

    static scheduleOverflowMaskSync() {
        if (UI.overflowMaskFrame) {
            cancelAnimationFrame(UI.overflowMaskFrame);
        }

        UI.overflowMaskFrame = requestAnimationFrame(() => {
            UI.overflowMaskFrame = null;
            UI.syncOverflowMask();
        });
    }

    static syncOverflowMask() {
        const root = document.documentElement;
        const viewportHeight = window.innerHeight;
        const scrollTop = window.scrollY || root.scrollTop || 0;
        const maxScrollTop = Math.max(root.scrollHeight - viewportHeight, 0);
        const isOverflowing = root.scrollHeight > viewportHeight + 1;
        const isAtBottom = scrollTop >= maxScrollTop - 1;

        document.body.classList.toggle('has-bottom-mask', isOverflowing && !isAtBottom);
    }

    static scrollToBottom() {
        const root = document.documentElement;
        const maxScrollTop = Math.max(root.scrollHeight - window.innerHeight, 0);

        window.scrollTo({
            top: maxScrollTop,
            behavior: 'smooth',
        });
    }
}

UI.SECTIONS_SELECTORS = [
    '#downloadForm',
    '#settingsForm',
    '#downloadSpinner',
    '#downloadSuccess',
    '#downloadFailed',
];

UI.overflowMaskInitialized = false;
UI.overflowMaskObserver = null;
UI.overflowMaskFrame = null;

export default UI;
