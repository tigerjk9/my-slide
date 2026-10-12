#!/usr/bin/env node
/**
 * share-deck 검증 스크립트
 *
 *   node .claude/skills/share-deck/scripts/verify.js [--out <dir>] [--index <index.html>]
 *
 * 1) 슬라이드별 스크린샷(slide-N.png)과 toc.png, qr.png, fullscreen.png, mobile.png 를 찍는다.
 * 2) 좌우 화살표·Home/End·해시 진입·목차·QR·전체화면·자동 숨김 동작을 점검한다.
 * 3) 슬라이드(1280×720) 밖으로 나간 글 요소를 찾아 overflow 로 보고한다.
 *
 * Playwright 를 찾지 못하면 헤드리스 Chrome/Edge 로 슬라이드 스크린샷만 찍는다.
 * Playwright 위치는 SHARE_DECK_PLAYWRIGHT 환경변수로 지정할 수 있다.
 * 결과는 <out>/summary.json 에도 남긴다. 실패가 하나라도 있으면 종료 코드 1.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..'); // scripts → share-deck → skills → .claude → 프로젝트
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const INDEX = path.resolve(opt('--index', path.join(ROOT, 'index.html')));
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'share-deck-check')));
const URL = pathToFileURL(INDEX).href;

if (!fs.existsSync(INDEX)) { console.error(`✖ ${INDEX} 가 없습니다. 먼저 node build.js 를 실행하세요.`); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const html = fs.readFileSync(INDEX, 'utf8');
const slideCount = (html.match(/class="deck-slide"/g) || []).length;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail || '' });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}
function finish(mode) {
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ mode, index: INDEX, slideCount, results }, null, 2));
  console.log(`\n${mode} · 슬라이드 ${slideCount}장 · 실패 ${failed.length}건 · 스크린샷: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

/* ---------- Playwright 찾기 ---------- */
function findPlaywright() {
  const home = os.homedir();
  const candidates = [
    process.env.SHARE_DECK_PLAYWRIGHT,
    'playwright',
    path.join(home, '.claude', 'skills', 'gstack', 'node_modules', 'playwright'),
    path.join(home, 'Desktop', 'GitHub Blog', 'ppt-automation', 'node_modules', 'playwright'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(require.resolve(c, { paths: [ROOT, __dirname] })); } catch (err) { /* 다음 후보 */ }
  }
  return null;
}

/* ---------- 헤드리스 브라우저 (대체 경로) ---------- */
function findBrowser() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(local, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function fallbackScreenshots() {
  const browser = findBrowser();
  if (!browser) { check('헤드리스 브라우저 찾기', false, 'Chrome/Edge 를 찾지 못했습니다'); return finish('none'); }
  console.log(`Playwright 가 없어 헤드리스 브라우저로 스크린샷만 찍습니다: ${browser}\n`);
  for (let i = 1; i <= slideCount; i += 1) {
    const file = path.join(OUT, `slide-${i}.png`);
    const r = spawnSync(browser, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=4000',
      '--window-size=1600,900', `--screenshot=${file}`, `${URL}#${i}`,
    ], { stdio: 'ignore', timeout: 60000 });
    check(`slide ${i} 스크린샷`, r.status === 0 && fs.existsSync(file), path.basename(file));
  }
  return finish('headless-screenshot');
}

/* ---------- Playwright 전체 점검 ---------- */
async function run(pw) {
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const consoleLog = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleLog.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => consoleLog.push(`[pageerror] ${e.message}`));

  const counter = () => page.textContent('#counter');
  const has = (sel, cls) => page.evaluate(([s, c]) => document.querySelector(s).classList.contains(c), [sel, cls]);
  const wait = (ms) => page.waitForTimeout(ms);

  await page.goto(URL);
  await wait(1800); // 웹 글꼴

  const domCount = await page.evaluate(() => document.querySelectorAll('.deck-slide').length);
  check('슬라이드 수', domCount === slideCount && slideCount > 0, `${domCount}장`);

  // 슬라이드별 스크린샷 + 넘침 검사
  for (let i = 1; i <= slideCount; i += 1) {
    await wait(700);
    await page.screenshot({ path: path.join(OUT, `slide-${i}.png`) });
    const over = await page.evaluate(() => {
      const slide = document.querySelector('.deck-slide.is-active .slide');
      if (!slide) return ['(.slide 요소 없음)'];
      const box = slide.getBoundingClientRect();
      const bad = [];
      slide.querySelectorAll('*').forEach((el) => {
        if (el.closest('svg')) return;
        const text = (el.textContent || '').trim();
        if (!text) return;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const out = r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1;
        const wide = el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible' && el.children.length === 0;
        if (out || wide) {
          const cls = (el.getAttribute('class') || '').split(/\s+/)[0];
          bad.push(`<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}> "${text.slice(0, 18)}"${out ? ' 바깥' : ' 가로넘침'}`);
        }
      });
      return bad;
    });
    check(`slide ${i} 글 요소가 슬라이드 안에 있음`, over.length === 0, over.length ? `overflow: ${over.join(', ')}` : `${await counter()}`);
    if (i < slideCount) await page.keyboard.press('ArrowRight');
  }

  await page.keyboard.press('ArrowRight'); await wait(200);
  check('마지막 장에서 → 눌러도 머무름', (await counter()) === `${slideCount} / ${slideCount}`, await counter());
  await page.keyboard.press('ArrowLeft'); await wait(300);
  check('← 로 이전 장', (await counter()) === `${Math.max(1, slideCount - 1)} / ${slideCount}`, await counter());

  // 목차
  await page.click('#tocBtn'); await wait(700);
  await page.screenshot({ path: path.join(OUT, 'toc.png') });
  const currentMarked = await page.$eval('.toc-item.is-current .toc-title', (el) => el.textContent).catch(() => null);
  check('[목차] 열림 + 현재 장 표시', (await has('#toc', 'is-open')) && Boolean(currentMarked), currentMarked || '');
  await page.click('.toc-item[data-go="0"]'); await wait(700);
  check('목차 항목 클릭으로 이동 + 닫힘', (await counter()) === `1 / ${slideCount}` && !(await has('#toc', 'is-open')), await counter());

  // QR
  await page.click('#qrBtn'); await wait(700);
  await page.screenshot({ path: path.join(OUT, 'qr.png') });
  const qrSvg = await page.evaluate(() => Boolean(document.querySelector('#qrCode svg')));
  const qrUrl = await page.textContent('#qrUrl');
  check('[QR] 생성 + 현재 주소 표시', qrSvg && qrUrl.startsWith(URL.split('#')[0]), qrUrl);
  await page.keyboard.press('ArrowRight'); await wait(300);
  check('장을 넘기면 QR 주소 갱신', (await page.textContent('#qrUrl')).endsWith('#2'), await page.textContent('#qrUrl'));
  await page.keyboard.press('Escape'); await wait(400);
  check('Escape 로 QR 닫힘', !(await has('#qr', 'is-open')));

  // 전체화면 + 자동 숨김
  await page.click('#fsBtn'); await wait(800);
  check('[전체화면] 진입 + 버튼 라벨', (await page.evaluate(() => Boolean(document.fullscreenElement))) && (await page.textContent('#fsBtn')) === '전체화면 해제');
  await page.mouse.move(800, 300); await wait(3200);
  check('전체화면에서 가만히 두면 조작 막대 숨김', await has('body', 'chrome-hidden'));
  await page.screenshot({ path: path.join(OUT, 'fullscreen.png') });
  await page.mouse.move(820, 320); await wait(300);
  check('마우스 움직이면 조작 막대 복귀', !(await has('body', 'chrome-hidden')));
  await page.keyboard.press('f'); await wait(600);
  check('F 키로 전체화면 해제', !(await page.evaluate(() => Boolean(document.fullscreenElement))));

  await page.keyboard.press('End'); await wait(300);
  check('End 로 마지막 장', (await counter()) === `${slideCount} / ${slideCount}`);
  await page.keyboard.press('Home'); await wait(300);
  check('Home 으로 첫 장', (await counter()) === `1 / ${slideCount}`);

  const target = Math.min(3, slideCount);
  await page.goto(`${URL}#${target}`); await wait(800);
  check(`#${target} 으로 직접 열기`, (await counter()) === `${target} / ${slideCount}`);

  await page.setViewportSize({ width: 390, height: 844 }); await wait(700);
  await page.screenshot({ path: path.join(OUT, 'mobile.png') });
  check('좁은 화면에서 버튼이 보임', await page.evaluate(() => ['tocBtn', 'qrBtn', 'fsBtn'].every((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return r.width > 0 && r.right <= window.innerWidth;
  })));

  check('콘솔 오류·경고 없음', consoleLog.length === 0, consoleLog.join(' | '));
  await browser.close();
  finish('playwright');
}

const pw = findPlaywright();
if (!pw) {
  fallbackScreenshots();
} else {
  run(pw).catch((err) => { console.error(err); check('검증 스크립트 실행', false, err.message); finish('playwright-error'); });
}
