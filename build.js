#!/usr/bin/env node
/**
 * build.js — slides/*.html 을 번호 순으로 모아 발표 페이지 index.html 을 만든다.
 *
 *   node build.js
 *
 * 입력
 *   deck.config.json         제목·부제·발표자·날짜 (슬라이드 안의 {{title}} 같은 자리에 들어간다)
 *   slides/NN-이름.html       슬라이드. 두 자리 번호로 시작하는 파일만 모은다. <body> 안쪽과 <style> 을 가져온다.
 *   assets/slide-theme.css   슬라이드 공통 스타일
 *   viewer/template.html     발표 페이지 틀
 *   viewer/viewer.css        발표 페이지 스타일
 *   viewer/viewer.js         발표 페이지 동작(좌우 화살표·목차·QR·전체화면)
 *   vendor/qrcode.min.js     QR 생성 라이브러리 (index.html 안에 그대로 들어간다)
 * 출력
 *   index.html               파일 하나로 완결된 발표 페이지
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PATHS = {
  config: path.join(ROOT, 'deck.config.json'),
  slides: path.join(ROOT, 'slides'),
  theme: path.join(ROOT, 'assets', 'slide-theme.css'),
  template: path.join(ROOT, 'viewer', 'template.html'),
  viewerCss: path.join(ROOT, 'viewer', 'viewer.css'),
  viewerJs: path.join(ROOT, 'viewer', 'viewer.js'),
  qr: path.join(ROOT, 'vendor', 'qrcode.min.js'),
  out: path.join(ROOT, 'index.html'),
};
const CONFIG_KEYS = ['title', 'subtitle', 'presenter', 'date'];
const SLIDE_FILE = /^(\d{2})-.+\.html?$/i;
const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/* ---------- 도우미 ---------- */
function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }
function fail(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }
function warn(msg) { console.warn(`  ! ${msg}`); }
function read(p) {
  if (!fs.existsSync(p)) fail(`${rel(p)} 파일이 없습니다.`);
  return fs.readFileSync(p, 'utf8');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// {{key}} 를 map[key] 로 바꾼다. 치환 결과는 다시 검사하지 않으므로 슬라이드 본문이 틀의 토큰과 섞이지 않는다.
function fill(text, map) {
  return text.replace(TOKEN, (whole, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : whole));
}
function leftoverTokens(text) {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[0]))];
}

/* ---------- 1. 설정 ---------- */
function loadConfig() {
  let config;
  try {
    config = JSON.parse(read(PATHS.config));
  } catch (err) {
    fail(`deck.config.json 을 읽을 수 없습니다: ${err.message}`);
  }
  const missing = CONFIG_KEYS.filter((k) => config[k] === undefined || !String(config[k]).trim());
  if (missing.length) fail(`deck.config.json 에 다음 항목이 비어 있습니다: ${missing.join(', ')}`);
  return config;
}

/* ---------- 2. 슬라이드 수집 ---------- */
function collectSlides(config) {
  if (!fs.existsSync(PATHS.slides)) fail('slides 폴더가 없습니다.');

  const files = fs.readdirSync(PATHS.slides)
    .filter((f) => SLIDE_FILE.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b, 'ko'));
  if (!files.length) fail('slides 폴더에 "01-이름.html" 형식의 파일이 없습니다.');

  const tokens = {};
  CONFIG_KEYS.forEach((k) => { tokens[k] = escapeHtml(config[k]); });

  const seen = new Map();
  return files.map((file, index) => {
    const num = file.match(SLIDE_FILE)[1];
    if (seen.has(num)) warn(`번호 ${num} 이 겹칩니다: ${seen.get(num)}, ${file}`);
    seen.set(num, file);

    const raw = read(path.join(PATHS.slides, file));

    // <style> 은 따로 모으고 본문에서는 뺀다.
    const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    const styles = [...raw.matchAll(styleRe)].map((m) => m[1].trim()).filter(Boolean);

    const bodyMatch = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    let body = (bodyMatch ? bodyMatch[1] : raw).replace(styleRe, '').trim();

    if (!/class\s*=\s*"[^"]*\bslide\b/.test(body)) {
      warn(`${file}: class="slide" 요소가 없습니다. 1280×720 크기가 맞지 않을 수 있습니다.`);
    }

    const titleAttr = body.match(/data-title\s*=\s*"([^"]*)"/i);
    const titleTag = raw.match(/<title>([\s\S]*?)<\/title>/i);
    const fallbackTitle = file.replace(SLIDE_FILE, (m, n) => m.slice(n.length + 1)).replace(/\.html?$/i, '').replace(/-/g, ' ');
    const title = fill((titleAttr && titleAttr[1].trim()) || (titleTag && titleTag[1].trim()) || fallbackTitle, tokens);

    body = fill(body, tokens);
    const leftover = leftoverTokens(body);
    if (leftover.length) warn(`${file}: deck.config.json 에 없는 자리표시자가 남았습니다: ${leftover.join(', ')}`);

    return { file, num, index, title, body, styles };
  });
}

/* ---------- 3. 조립 ---------- */
function build() {
  const config = loadConfig();
  const slides = collectSlides(config);

  const slidesHtml = slides.map((s) => [
    `<!-- slides/${s.file} -->`,
    `<div class="deck-slide" id="slide-${s.index + 1}" data-index="${s.index}" data-title="${escapeHtml(s.title)}" aria-hidden="true">`,
    s.body,
    '</div>',
  ].join('\n')).join('\n\n');

  const slideStyles = slides
    .filter((s) => s.styles.length)
    .map((s) => `/* slides/${s.file} */\n${s.styles.join('\n')}`)
    .join('\n\n');

  const tocHtml = slides.map((s) =>
    `    <li><button type="button" class="toc-item" data-go="${s.index}">` +
    `<span class="toc-num">${s.num}</span><span class="toc-title">${escapeHtml(s.title)}</span></button></li>`,
  ).join('\n');

  const deckInfo = {};
  CONFIG_KEYS.forEach((k) => { deckInfo[k] = config[k]; });
  deckInfo.slides = slides.map((s) => ({ file: s.file, title: s.title }));
  // </script> 로 끊기지 않도록 < 를 이스케이프한다.
  const configJson = JSON.stringify(deckInfo).replace(/</g, '\\u003c');

  const map = {
    title: escapeHtml(config.title),
    subtitle: escapeHtml(config.subtitle),
    presenter: escapeHtml(config.presenter),
    date: escapeHtml(config.date),
    count: String(slides.length),
    slides: slidesHtml,
    slide_styles: slideStyles,
    toc: tocHtml,
    theme_css: read(PATHS.theme).trim(),
    viewer_css: read(PATHS.viewerCss).trim(),
    viewer_js: read(PATHS.viewerJs).trim(),
    qr_js: read(PATHS.qr).trim(),
    config_json: configJson,
    built_at: new Date().toISOString(),
  };

  const template = read(PATHS.template);
  const html = fill(template, map);
  const leftover = leftoverTokens(template).filter((t) => !Object.prototype.hasOwnProperty.call(map, t.replace(/[{}\s]/g, '')));
  if (leftover.length) warn(`viewer/template.html 에 채우지 못한 자리표시자가 있습니다: ${leftover.join(', ')}`);

  fs.writeFileSync(PATHS.out, html, 'utf8');

  console.log(`\n${config.title} · ${config.subtitle}  (${config.presenter}, ${config.date})`);
  slides.forEach((s) => console.log(`  ${s.num}  ${s.title}  ← slides/${s.file}`));
  console.log(`\n→ index.html  ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB, 슬라이드 ${slides.length}장`);
  console.log('  슬라이드를 고친 뒤에는 다시 `node build.js` 를 실행하세요.\n');
}

build();
