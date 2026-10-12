/* viewer/viewer.js — 발표 페이지 동작(화살표·목차·QR·전체화면). build.js 가 index.html 안에 끼워 넣는다. */
(function () {
  'use strict';

  const SLIDE_W = 1280;
  const SLIDE_H = 720;
  const HIDE_CHROME_AFTER = 2500; // 전체화면에서 조작 막대를 숨기기까지 기다리는 시간(ms)

  const $ = (id) => document.getElementById(id);
  const wrap = $('stageWrap');
  const stage = $('stage');
  const bar = $('bar');
  const slides = Array.from(stage.querySelectorAll('.deck-slide'));
  const total = slides.length;

  const counter = $('counter');
  const progress = $('progress');
  const prevBtn = $('prevBtn');
  const nextBtn = $('nextBtn');
  const tocBtn = $('tocBtn');
  const qrBtn = $('qrBtn');
  const fsBtn = $('fsBtn');
  const toc = $('toc');
  const qr = $('qr');
  const qrCode = $('qrCode');
  const qrUrl = $('qrUrl');
  const qrHint = $('qrHint');
  const copyBtn = $('copyBtn');
  const scrim = $('scrim');
  const tocItems = Array.from(toc.querySelectorAll('.toc-item'));

  let current = -1;
  let hideTimer = 0;

  if (!total) {
    counter.textContent = '0 / 0';
    return;
  }

  /* ---------- 화면 맞춤: 1280×720 무대를 통째로 축소·확대 ---------- */
  function fit() {
    const scale = Math.min(wrap.clientWidth / SLIDE_W, wrap.clientHeight / SLIDE_H);
    stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }
  if ('ResizeObserver' in window) new ResizeObserver(fit).observe(wrap);
  window.addEventListener('resize', fit);
  fit();

  /* ---------- 슬라이드 이동 ---------- */
  function indexFromHash() {
    const n = parseInt(location.hash.slice(1), 10);
    return Number.isFinite(n) ? n - 1 : 0;
  }

  function go(target) {
    const index = Math.max(0, Math.min(total - 1, target));
    if (index === current) return;

    stage.dataset.dir = index > current ? 'next' : 'prev';
    slides.forEach((el, i) => {
      el.classList.toggle('is-active', i === index);
      el.setAttribute('aria-hidden', String(i !== index));
    });
    current = index;

    counter.textContent = `${index + 1} / ${total}`;
    progress.style.width = `${((index + 1) / total) * 100}%`;
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index === total - 1;
    tocItems.forEach((b) => b.classList.toggle('is-current', Number(b.dataset.go) === index));

    const hash = `#${index + 1}`;
    if (location.hash !== hash) {
      try { history.replaceState(null, '', hash); } catch (err) { location.hash = hash; }
    }
    if (isOpen(qr)) renderQr(); // 주소가 바뀌었으니 QR도 새로 그린다
  }
  const next = () => go(current + 1);
  const prev = () => go(current - 1);

  prevBtn.addEventListener('click', prev);
  nextBtn.addEventListener('click', next);
  window.addEventListener('hashchange', () => go(indexFromHash()));

  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const onButton = e.target instanceof Element && e.target.closest('button');
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown':
        e.preventDefault(); next(); break;
      case ' ':
        if (onButton) return; // 버튼에 초점이 있으면 버튼이 처리한다
        e.preventDefault(); next(); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace':
        e.preventDefault(); prev(); break;
      case 'Home': e.preventDefault(); go(0); break;
      case 'End': e.preventDefault(); go(total - 1); break;
      case 'Escape': closeAll(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      default: break;
    }
  });

  // 터치: 좌우로 밀어서 넘기기
  let touchStartX = null;
  wrap.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].clientX; }, { passive: true });
  wrap.addEventListener('touchend', (e) => {
    if (touchStartX === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(dx) < 50) return;
    if (dx < 0) next(); else prev();
  }, { passive: true });

  /* ---------- 목차·QR 패널 ---------- */
  const isOpen = (panel) => panel.classList.contains('is-open');
  const anyOpen = () => isOpen(toc) || isOpen(qr);

  function setOpen(panel, btn, open) {
    panel.classList.toggle('is-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    btn.setAttribute('aria-expanded', String(open));
    scrim.hidden = !anyOpen();
    if (open) { showChrome(); clearTimeout(hideTimer); } else { armHide(); }
  }
  function closeAll() {
    setOpen(toc, tocBtn, false);
    setOpen(qr, qrBtn, false);
  }

  tocBtn.addEventListener('click', () => {
    const open = !isOpen(toc);
    setOpen(qr, qrBtn, false);
    setOpen(toc, tocBtn, open);
    if (open) (tocItems[current] || tocItems[0]).focus();
  });
  qrBtn.addEventListener('click', () => {
    const open = !isOpen(qr);
    setOpen(toc, tocBtn, false);
    setOpen(qr, qrBtn, open);
    if (open) renderQr();
  });
  scrim.addEventListener('click', closeAll);
  toc.addEventListener('click', (e) => {
    const item = e.target.closest('.toc-item');
    if (!item) return;
    go(Number(item.dataset.go));
    closeAll();
  });

  /* ---------- QR: 지금 페이지 주소 ---------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function qrSvg(text) {
    if (qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs['UTF-8']) {
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
    }
    let code = null;
    let lastError = null;
    for (let type = 0; type <= 40 && !code; type += 1) {
      try {
        const c = qrcode(type, 'M');
        c.addData(text);
        c.make();
        code = c;
      } catch (err) { lastError = err; }
    }
    if (!code) throw lastError || new Error('주소가 너무 길어 QR로 만들 수 없습니다.');

    const n = code.getModuleCount();
    const margin = 2;
    const size = n + margin * 2;
    let d = '';
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        if (code.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="현재 페이지 주소 QR 코드">` +
      `<rect width="${size}" height="${size}" fill="#fffdf8"/><path d="${d}" fill="#1f2e2a"/></svg>`;
  }

  function renderQr() {
    const url = location.href;
    qrUrl.textContent = url;
    try {
      if (typeof qrcode !== 'function') throw new Error('vendor/qrcode.min.js 가 포함되지 않았습니다.');
      qrCode.innerHTML = qrSvg(url);
    } catch (err) {
      qrCode.innerHTML = `<p class="qr-error">QR을 만들 수 없습니다.<br>${escapeHtml(err && err.message ? err.message : err)}</p>`;
    }
    if (location.protocol === 'file:') {
      qrHint.textContent = '지금은 내 컴퓨터의 파일 주소라서 휴대전화에서 열리지 않습니다. 웹에 올린 뒤 그 주소로 열면 바로 쓸 수 있습니다.';
      qrHint.classList.add('is-warn');
    } else {
      qrHint.textContent = '휴대전화 카메라로 스캔하면 이 발표 페이지가 열립니다.';
      qrHint.classList.remove('is-warn');
    }
  }

  copyBtn.addEventListener('click', async () => {
    const original = '주소 복사';
    try {
      await navigator.clipboard.writeText(location.href);
      copyBtn.textContent = '복사했습니다';
    } catch (err) {
      copyBtn.textContent = '복사하지 못했습니다. 위 주소를 직접 선택해 주세요.';
    }
    setTimeout(() => { copyBtn.textContent = original; }, 1800);
  });

  /* ---------- 전체화면 ---------- */
  function toggleFullscreen() {
    if (!document.fullscreenEnabled) return;
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    const p = document.documentElement.requestFullscreen();
    if (p && p.catch) p.catch(() => {});
  }
  fsBtn.addEventListener('click', toggleFullscreen);
  if (!document.fullscreenEnabled) {
    fsBtn.disabled = true;
    fsBtn.title = '이 브라우저에서는 전체화면을 쓸 수 없습니다.';
  }
  document.addEventListener('fullscreenchange', () => {
    const on = Boolean(document.fullscreenElement);
    fsBtn.setAttribute('aria-pressed', String(on));
    fsBtn.textContent = on ? '전체화면 해제' : '전체화면';
    showChrome();
    armHide();
  });

  /* ---------- 전체화면에서 가만히 두면 조작 막대를 숨긴다 ---------- */
  function showChrome() { document.body.classList.remove('chrome-hidden'); }
  function armHide() {
    clearTimeout(hideTimer);
    if (!document.fullscreenElement || anyOpen()) return;
    hideTimer = setTimeout(() => {
      if (bar.matches(':hover')) { armHide(); return; }
      document.body.classList.add('chrome-hidden');
    }, HIDE_CHROME_AFTER);
  }
  ['mousemove', 'mousedown', 'keydown', 'touchstart'].forEach((ev) => {
    document.addEventListener(ev, () => { showChrome(); armHide(); }, { passive: true });
  });

  /* ---------- 시작 ---------- */
  go(indexFromHash());
})();
