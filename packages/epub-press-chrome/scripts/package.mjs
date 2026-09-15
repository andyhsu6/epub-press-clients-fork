#!/usr/bin/env node
// Build the extension and produce distributable artifacts in releases/:
//   - epubpressx-chrome-<version>.zip  (for "Load unpacked")
//   - epubpressx-chrome-<version>.crx  (signed sideload, if a Chromium browser is available)
// A stable key (releases/epubpressx-chrome.key.pem) is reused so the extension ID
// stays the same across versions. Pass CHROME_BIN to override browser detection.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'app');
const releasesDir = path.join(root, 'releases');
const keyPath = path.join(releasesDir, 'epubpressx-chrome.key.pem');

const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json'), 'utf8'));
const version = manifest.version;
const base = `epubpressx-chrome-${version}`;

function walk(dir, rel = '') {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) files.push(...walk(abs, r));
        else files.push([r, abs]);
    }
    return files;
}

async function makeZip() {
    const zip = new JSZip();
    for (const [rel, abs] of walk(appDir)) {
        zip.file(`${base}/${rel}`, fs.readFileSync(abs));
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const out = path.join(releasesDir, `${base}.zip`);
    fs.writeFileSync(out, buffer);
    return out;
}

function which(bin) {
    const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE').split(';') : [''];
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        for (const ext of exts) {
            const p = path.join(dir, bin + ext);
            if (fs.existsSync(p)) return p;
        }
    }
    return null;
}

function findBrowser() {
    if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
        return process.env.CHROME_BIN;
    }
    const candidates = [];
    if (process.platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        );
    } else if (process.platform === 'linux') {
        for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge']) {
            const p = which(bin);
            if (p) candidates.push(p);
        }
    } else if (process.platform === 'win32') {
        candidates.push(
            'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        );
    }
    return candidates.find((p) => fs.existsSync(p)) || null;
}

function makeCrx(browser) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epubpressx-pack-'));
    const stage = path.join(tmp, base);
    fs.cpSync(appDir, stage, { recursive: true });

    const args = [`--pack-extension=${stage}`, '--no-message-box'];
    if (fs.existsSync(keyPath)) args.push(`--pack-extension-key=${keyPath}`);
    // Chrome/Brave may exit non-zero even on success; verify by artifact instead.
    spawnSync(browser, args, { stdio: 'ignore' });

    const crx = path.join(tmp, `${base}.crx`);
    const pem = path.join(tmp, `${base}.pem`);
    try {
        if (!fs.existsSync(crx)) {
            throw new Error(`CRX was not produced by ${browser}`);
        }
        if (!fs.existsSync(keyPath) && fs.existsSync(pem)) {
            fs.copyFileSync(pem, keyPath); // persist key for stable extension ID
        }
        const out = path.join(releasesDir, `${base}.crx`);
        fs.copyFileSync(crx, out);
        return out;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function cleanReleases() {
    for (const name of fs.readdirSync(releasesDir)) {
        const isStale = /^epubpressx-chrome-.*\.(zip|crx)$/.test(name) || name === 'app.crx';
        if (isStale) fs.rmSync(path.join(releasesDir, name), { force: true });
    }
}

async function main() {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const build = spawnSync(npm, ['run', 'build-prod'], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) {
        throw new Error(`build-prod failed with exit code ${build.status}`);
    }

    fs.mkdirSync(releasesDir, { recursive: true });
    cleanReleases();

    const zip = await makeZip();
    console.log(`zip  ${path.relative(root, zip)}`);

    const browser = findBrowser();
    if (browser) {
        const crx = makeCrx(browser);
        console.log(`crx  ${path.relative(root, crx)}`);
    } else {
        console.warn('crx  skipped (no Chromium browser found; set CHROME_BIN to enable)');
    }

    console.log(`done ${base}`);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
