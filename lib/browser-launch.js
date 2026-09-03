'use strict';

const path = require('path');

const MAX_BROWSER_URL_CHARS = 8192;

function validateBrowserUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('url required');
  if (value.length > MAX_BROWSER_URL_CHARS) throw new Error(`url exceeds ${MAX_BROWSER_URL_CHARS} characters`);
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('url must not contain surrounding whitespace or control characters');
  }
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error('url must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('only http(s) urls allowed');
  if (parsed.username || parsed.password) throw new Error('browser URLs must not contain embedded credentials');
  if (parsed.href.length > MAX_BROWSER_URL_CHARS) {
    throw new Error(`normalized url exceeds ${MAX_BROWSER_URL_CHARS} characters`);
  }
  return parsed.href;
}

function item(bin, url, extraArgs = []) {
  return { bin, args: [...extraArgs, url] };
}

function chromeOpeners(platform, url, env = process.env) {
  if (platform.isWSL) {
    return [
      item('/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', url),
      item('/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe', url),
      item('chrome.exe', url),
      item('google-chrome', url),
      item('google-chrome-stable', url),
    ];
  }
  if (platform.isWindows) {
    return [
      env.PROGRAMFILES && item(path.win32.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'), url),
      env['PROGRAMFILES(X86)'] && item(path.win32.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'), url),
      env.LOCALAPPDATA && item(path.win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'), url),
      item('chrome.exe', url),
    ].filter(Boolean);
  }
  if (platform.isMac) {
    return [
      item('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', url),
      item('open', url, ['-a', 'Google Chrome']),
    ];
  }
  return [item('google-chrome', url), item('google-chrome-stable', url)];
}

function defaultOpeners(platform, url) {
  if (platform.isWSL) return [item('wslview', url), item('explorer.exe', url), item('xdg-open', url)];
  if (platform.isWindows) return [item('explorer.exe', url)];
  if (platform.isMac) return [item('open', url)];
  return [item('xdg-open', url), item('gio', url, ['open']), item('x-www-browser', url)];
}

function browserOpeners(browser, platform, url, env = process.env) {
  if (browser == null || browser === '' || browser === 'default') return defaultOpeners(platform, url);
  if (browser === 'chrome') return chromeOpeners(platform, url, env);
  throw new Error('browser must be default or chrome');
}

module.exports = {
  MAX_BROWSER_URL_CHARS,
  validateBrowserUrl,
  chromeOpeners,
  defaultOpeners,
  browserOpeners,
};
