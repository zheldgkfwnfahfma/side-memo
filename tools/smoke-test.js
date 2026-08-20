/**
 * 기능 점검용 스모크 테스트.
 *   node tools/smoke-test.js
 *
 * 임시 userData 폴더에서 앱을 띄우므로 실제 메모는 건드리지 않는다.
 * 렌더러에 자바스크립트를 주입해 실제 UI를 조작하고 결과를 확인한다.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9333;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'sidememo-test-'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
};

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

/** 디버깅 프로토콜로 렌더러에 코드를 넣고 결과를 받아온다. */
async function evalInPage(ws, expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMessage = (data) => {
      const msg = JSON.parse(data);
      if (msg.id !== id) return;
      ws.removeListener('message', onMessage);
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      const r = msg.result.result;
      if (r.subtype === 'error') return reject(new Error(r.description));
      resolve(r.value);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('임시 프로필:', PROFILE, '\n');
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  let targets = [];
  for (let i = 0; i < 40 && !targets.length; i++) {
    await sleep(500);
    try { targets = (await get('/json/list')).filter((t) => t.type === 'page'); } catch { /* 아직 안 뜸 */ }
  }
  if (!targets.length) {
    console.error('창을 찾지 못했습니다.', logs.join(''));
    child.kill();
    process.exit(1);
  }

  const WebSocket = require('ws');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  await sleep(1500);   // init() 완료 대기

  try {
    // ── 안전장치: 임시 프로필을 쓰고 있는지 먼저 확인한다 ──
    // (실제 프로필에 붙었는데 아래 테스트를 돌리면 진짜 메모를 덮어쓴다)
    // Store 가 만드는 images/files 폴더가 임시 프로필 안에 있으면 제대로 격리된 것이다.
    const usingTempProfile = fs.existsSync(path.join(PROFILE, 'files'))
                          && fs.existsSync(path.join(PROFILE, 'images'));
    if (!usingTempProfile) {
      check('임시 프로필 사용', false, '실제 프로필에 붙었습니다. 중단합니다.');
      throw new Error('abort: real profile');
    }
    check('임시 프로필 사용', true, PROFILE);

    // ── 초기 상태 ──────────────────────────────────────
    check('창이 하나 뜬다', targets.length === 1, `${targets.length}개`);
    check('상태 로딩됨', await evalInPage(ws, '!!(state && state.dock && state.settings)'));
    check('기본 메모 3개', (await evalInPage(ws, 'state.dock.tabs.length')) === 3);
    check('탭 버튼 렌더링됨', (await evalInPage(ws, 'document.querySelectorAll("#tabs .tab").length')) === 3);

    // ── 이미지 크기 슬라이더 (이번에 고친 것) ───────────
    await evalInPage(ws, `
      editor.innerHTML = '<img src="sidememo-img://img/none.png" style="width:60%">';
      const img = editor.querySelector('img');
      selectedImg = img; img.classList.add('selected');
      document.querySelector('#img-tools').hidden = false;
      true`);
    // mousedown 이 막히지 않아야 슬라이더를 끌 수 있다
    const notBlocked = await evalInPage(ws, `
      (() => {
        const el = document.querySelector('#img-size');
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return !ev.defaultPrevented;
      })()`);
    check('크기 슬라이더 mousedown 이 막히지 않음', notBlocked);

    const sliderWorks = await evalInPage(ws, `
      (() => {
        const el = document.querySelector('#img-size');
        el.value = 35;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return editor.querySelector('img').style.width;
      })()`);
    check('슬라이더로 이미지 폭 변경', sliderWorks === '35%', sliderWorks);

    const presetWorks = await evalInPage(ws, `
      document.querySelector('#img-tools .ratios button[data-ratio="75"]').click();
      editor.querySelector('img').style.width`);
    check('비율 버튼(75%) 동작', presetWorks === '75%', presetWorks);

    const handleShown = await evalInPage(ws, `
      placeImageHandle(); !document.querySelector('#img-handle').hidden`);
    check('이미지 크기 조절 손잡이 표시', handleShown);

    // ── 첨부파일 ──────────────────────────────────────
    const saved = await evalInPage(ws, `
      (async () => {
        const buf = new TextEncoder().encode('hello attachment').buffer;
        const r = await window.sideMemo.saveFile(buf, '보고서.docx');
        insertFileChip(r);
        return JSON.stringify({ name: r.name, chips: editor.querySelectorAll('.file-chip').length });
      })()`);
    const parsed = JSON.parse(saved);
    check('파일 첨부 → 칩 삽입', parsed.chips === 1 && parsed.name === '보고서.docx', saved);
    check('첨부파일이 디스크에 저장됨', fs.readdirSync(path.join(PROFILE, 'files')).length === 1);

    // 탐색기에서 알아볼 수 있도록 원래 이름 그대로 저장돼야 한다
    check('원래 이름 그대로 저장된다',
      fs.existsSync(path.join(PROFILE, 'files', '보고서.docx')),
      fs.readdirSync(path.join(PROFILE, 'files')).join(', '));

    // 같은 이름을 또 넣으면 덮어쓰지 않고 비켜 가야 한다
    const dupFile = await evalInPage(ws, `
      (async () => {
        const buf = new TextEncoder().encode('두 번째').buffer;
        const r = await window.sideMemo.saveFile(buf, '보고서.docx');
        return r.token;
      })()`);
    check('같은 이름은 (2) 로 비켜 간다', dupFile === '보고서 (2).docx', dupFile);
    check('먼저 넣은 첨부를 덮어쓰지 않는다',
      fs.readFileSync(path.join(PROFILE, 'files', '보고서.docx'), 'utf8') === 'hello attachment');

    // 이름에 & 가 있어도 넣고, 다시 열 수 있어야 한다
    const amp = await evalInPage(ws, `
      (async () => {
        const buf = new TextEncoder().encode('AMP').buffer;
        const r = await window.sideMemo.saveFile(buf, 'A&B 자료.txt');
        editor.innerHTML = '';
        insertFileChip(r);
        const chip = editor.querySelector('.file-chip');
        return JSON.stringify({
          token: r.token,
          attr: chip.getAttribute('data-file'),
          readBack: chip.dataset.file,
        });
      })()`);
    const ampR = JSON.parse(amp);
    check('& 가 든 이름도 그대로 저장된다',
      ampR.token === 'A&B 자료.txt' && fs.existsSync(path.join(PROFILE, 'files', 'A&B 자료.txt')), amp);
    check('메모 안에서는 인코딩된 형태로 들어간다',
      ampR.attr === encodeURIComponent('A&B 자료.txt'), ampR.attr);

    // 메인이 그 값을 되돌려 실제 파일을 찾아내는지 (열기가 성공해야 한다)
    const openRes = await evalInPage(ws, `
      (async () => JSON.stringify(await window.sideMemo.openFile(
        document.querySelector('.file-chip').dataset.file)))()`);
    check('인코딩된 값으로도 파일을 찾아낸다', JSON.parse(openRes).ok === true, openRes);

    // 폴더 밖을 가리키는 값은 여전히 거절돼야 한다
    const escape = await evalInPage(ws, `
      (async () => JSON.stringify(await window.sideMemo.openFile('..%2F..%2Fdata.json')))()`);
    check('폴더 밖은 못 연다', JSON.parse(escape).ok === false, escape);

    await evalInPage(ws, "editor.innerHTML = ''; flushSave(); true");

    // ── 이미지 장수 제한 없음 ──────────────────────────
    const many = await evalInPage(ws, `
      editor.innerHTML = Array.from({length: 12}, () => '<img src="x" style="width:20%">').join('');
      editor.querySelectorAll('img').length`);
    check('이미지 12장 삽입 가능(제한 없음)', many === 12, `${many}장`);

    // ── 탭 / 저장 ─────────────────────────────────────
    const tabAdded = await evalInPage(ws, 'addTab(); state.dock.tabs.length');
    check('새 메모 추가', tabAdded === 4, `${tabAdded}개`);

    await evalInPage(ws, `
      editor.innerHTML = '<div>저장 테스트</div>'; flushSave(); true`);
    await sleep(600);
    const onDisk = JSON.parse(fs.readFileSync(path.join(PROFILE, 'data.json'), 'utf8'));
    const savedTab = onDisk.docks[0].tabs.find((t) => t.id === onDisk.docks[0].activeTabId);
    check('메모 내용이 파일에 저장됨', /저장 테스트/.test(savedTab.html || ''), savedTab.html);

    // ── 탭 색상 ↔ 알약 색 연동 ─────────────────────────
    const chipInit = await evalInPage(ws, `
      JSON.stringify({
        chip: getComputedStyle(document.querySelector('#chip-tab')).backgroundColor,
        tab: getComputedStyle(document.querySelector('#tabs .tab.active')).backgroundColor,
      })`);
    const ci = JSON.parse(chipInit);
    check('알약이 처음부터 탭 색을 따라간다', ci.chip === ci.tab, chipInit);

    const chipPick = await evalInPage(ws, `
      (() => {
        document.querySelector('#chip-tab').click();
        const sw = document.querySelector('#pop-tabcolor .sw[data-color="#BBF7D0"]');
        sw.click();
        return JSON.stringify({
          color: activeTab().color,
          chip: getComputedStyle(document.querySelector('#chip-tab')).backgroundColor,
          tab: getComputedStyle(document.querySelector('#tabs .tab.active')).backgroundColor,
        });
      })()`);
    const cp = JSON.parse(chipPick);
    check('색을 고르면 탭과 알약이 함께 바뀐다',
      cp.color === '#BBF7D0' && cp.chip === 'rgb(187, 247, 208)' && cp.chip === cp.tab, chipPick);

    const chipMarked = await evalInPage(ws, `
      (() => {
        document.querySelector('#chip-tab').click();
        const on = [...document.querySelectorAll('#pop-tabcolor .sw.on')].map(b => b.dataset.color);
        closeAllPopovers();
        return JSON.stringify(on);
      })()`);
    check('고른 색에 표시가 남는다', JSON.parse(chipMarked).join() === '#BBF7D0', chipMarked);

    // 탭을 옮겨 다녀도 알약이 그 탭 색을 따라와야 한다
    const chipSwitch = await evalInPage(ws, `
      (() => {
        const other = state.dock.tabs.find(t => t.id !== state.dock.activeTabId);
        other.color = '#FDE68A';
        selectTab(other.id);
        return JSON.stringify({
          chip: getComputedStyle(document.querySelector('#chip-tab')).backgroundColor,
          label: document.querySelector('#chip-label').textContent,
          name: other.name,
        });
      })()`);
    const cs = JSON.parse(chipSwitch);
    check('탭을 바꾸면 알약 색도 따라온다',
      cs.chip === 'rgb(253, 230, 138)' && cs.label === cs.name, chipSwitch);

    check('밝은 색엔 어두운 글자를 얹는다',
      (await evalInPage(ws, "readableOn('#FDE68A')")) === '#3b2a6b');
    check('어두운 색엔 밝은 글자를 얹는다',
      (await evalInPage(ws, "readableOn('#20143f')")) === '#ffffff');

    // 원래 보던 탭으로 돌아가 뒤 검사에 영향을 주지 않게 한다
    await evalInPage(ws, 'selectTab(state.dock.tabs[state.dock.tabs.length - 1].id); true');

    // ── 메모별 폭 ─────────────────────────────────────
    await evalInPage(ws, 'commitWidth(500); true');
    await sleep(300);
    await evalInPage(ws, 'activeTab().panelWidth = 640; flushSave(); true');
    await sleep(600);
    const widths = JSON.parse(fs.readFileSync(path.join(PROFILE, 'data.json'), 'utf8'));
    const wTab = widths.docks[0].tabs.find((t) => t.id === widths.docks[0].activeTabId);
    check('메모별 폭 저장', wTab.panelWidth === 640, String(wTab.panelWidth));

    // ── 가장자리(dock) 추가/삭제 ───────────────────────
    const add1 = await evalInPage(ws, '(async () => JSON.stringify(await window.sideMemo.addDock()))()');
    check('가장자리 추가', JSON.parse(add1).ok, add1);
    await sleep(800);
    const afterAdd = (await get('/json/list')).filter((t) => t.type === 'page');
    check('추가하면 창이 하나 더 뜬다', afterAdd.length === 2, `${afterAdd.length}개`);

    // 다른 dock 과 (모니터, 가장자리)가 정확히 같아지도록 옮겨본다 → 거부돼야 한다
    const dupe = await evalInPage(ws, `
      (async () => {
        const other = state.docks.find(d => d.id !== state.dock.id);
        return JSON.stringify(await window.sideMemo.updateDock({
          edge: other.edge, displayId: other.displayId }));
      })()`);
    check('같은 자리로는 못 옮김(충돌 거부)', JSON.parse(dupe).ok === false, dupe);

    const removed = await evalInPage(ws, `
      (async () => JSON.stringify(await window.sideMemo.removeDock(
        state.docks.find(d => d.id !== state.dock.id).id)))()`);
    check('가장자리 삭제', JSON.parse(removed).ok, removed);
    await sleep(600);
    const afterRemove = (await get('/json/list')).filter((t) => t.type === 'page');
    check('삭제하면 창도 닫힌다', afterRemove.length === 1, `${afterRemove.length}개`);

    const lastOne = await evalInPage(ws, '(async () => JSON.stringify(await window.sideMemo.removeDock(state.dock.id)))()');
    check('마지막 하나는 삭제 거부', JSON.parse(lastOne).ok === false, lastOne);

    // ── 단축키 ────────────────────────────────────────
    const scOff = await evalInPage(ws, `
      (async () => { await window.sideMemo.saveSettings({ ...state.settings, shortcutsEnabled: false });
                     return 'ok'; })()`);
    check('단축키 끄기 호출됨', scOff === 'ok');

    const scSet = await evalInPage(ws, `
      (async () => JSON.stringify(await window.sideMemo.setShortcuts({ toggle: 'Control+Alt+F9' })))()`);
    check('단축키 변경 저장', JSON.parse(scSet).shortcuts.toggle === 'Control+Alt+F9', scSet);

    const accel = await evalInPage(ws, `
      JSON.stringify([
        accelFrom({ key: 'k', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }),
        accelFrom({ key: 'k', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }),
        accelFrom({ key: 'Control', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }),
        accelFrom({ key: 'ArrowLeft', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })
      ])`);
    check('단축키 문자열 변환', accel === '["Control+Alt+K",null,null,"Control+Left"]', accel);

    // ── 휴지통 ────────────────────────────────────────
    const trashed = await evalInPage(ws, `
      (async () => {
        const victim = state.dock.tabs[state.dock.tabs.length - 1];
        victim.html = '<div>휴지통 확인용</div>';
        await removeTab(victim.id);
        const list = await window.sideMemo.trashList();
        return JSON.stringify({ tabs: state.dock.tabs.length, trash: list.length, name: list[0].name,
                                preview: list[0].preview });
      })()`);
    const t = JSON.parse(trashed);
    check('메모 삭제 → 휴지통행', t.trash === 1 && t.tabs === 3, trashed);

    const restored = await evalInPage(ws, `
      (async () => {
        const list = await window.sideMemo.trashList();
        await window.sideMemo.trashRestore(list[0].id);
        const after = await window.sideMemo.trashList();
        return JSON.stringify({ trash: after.length });
      })()`);
    check('휴지통에서 되돌리기', JSON.parse(restored).trash === 0, restored);
    await sleep(500);
    // 삭제 직전 편집 중이던 내용이 확정되어 들어가므로, 내용이 아니라 개수로 확인한다.
    const restoredOnDisk = JSON.parse(fs.readFileSync(path.join(PROFILE, 'data.json'), 'utf8'));
    check('되돌린 메모가 파일에 복구됨',
      restoredOnDisk.docks[0].tabs.length === 4 && restoredOnDisk.trash.length === 0,
      `탭 ${restoredOnDisk.docks[0].tabs.length}개 / 휴지통 ${restoredOnDisk.trash.length}개`);

    const emptied = await evalInPage(ws, `
      (async () => {
        await removeTab(state.dock.tabs[state.dock.tabs.length - 1].id);
        await window.sideMemo.trashEmpty();
        return (await window.sideMemo.trashList()).length;
      })()`);
    check('휴지통 비우기', emptied === 0, String(emptied));

    // ── 백업 ─────────────────────────────────────────
    check('실행 시 자동 백업 생성', fs.existsSync(path.join(PROFILE, 'backups'))
      && fs.readdirSync(path.join(PROFILE, 'backups')).length >= 1,
      String(fs.readdirSync(path.join(PROFILE, 'backups')).length));

    const bk = await evalInPage(ws, '(async () => JSON.stringify(await window.sideMemo.backupNow()))()');
    check('수동 백업', JSON.parse(bk).ok, bk);
    const bkList = await evalInPage(ws, '(async () => (await window.sideMemo.backupList()).length)()');
    check('백업 목록 조회', bkList >= 2, `${bkList}개`);

    // ── 저장 위치 ─────────────────────────────────────
    const loc = await evalInPage(ws, '(async () => JSON.stringify(await window.sideMemo.dataLocation()))()');
    const parsedLoc = JSON.parse(loc);
    check('저장 위치가 임시 프로필', parsedLoc.dir === PROFILE && parsedLoc.isDefault, loc);

    // ── 통합 검색 ─────────────────────────────────────
    await evalInPage(ws, `
      (async () => {
        state.dock.tabs[0].html = '<div>분기 <b>매출</b> 보고서 초안</div>';
        state.dock.tabs[1].html = '<div>관계 없는 내용</div>';
        state.dock.activeTabId = state.dock.tabs[1].id;
        await window.sideMemo.saveTabs({ tabs: state.dock.tabs, activeTabId: state.dock.activeTabId });
      })()`);
    const hits = await evalInPage(ws, '(async () => JSON.stringify(await window.sideMemo.search("매출")))()');
    const parsedHits = JSON.parse(hits);
    check('검색 결과 1건', parsedHits.length === 1, hits);
    check('검색 미리보기에 태그가 안 섞임',
      parsedHits.length === 1 && !/[<>]/.test(parsedHits[0].snippet), parsedHits[0] && parsedHits[0].snippet);
    const noHit = await evalInPage(ws, '(async () => (await window.sideMemo.search("없는단어")).length)()');
    check('없는 단어는 0건', noHit === 0, String(noHit));
    const byName = await evalInPage(ws, '(async () => (await window.sideMemo.search("TODO")).length)()');
    check('메모 이름으로도 검색', byName >= 1, `${byName}건`);

    const searchUI = await evalInPage(ws, `
      (async () => {
        window.openSearch();
        const el = document.querySelector('#search-input');
        el.value = '매출';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        return JSON.stringify({
          open: !document.querySelector('#search').hidden,
          rows: document.querySelectorAll('#search-results .hit').length,
          marked: document.querySelectorAll('#search-results mark').length,
        });
      })()`);
    check('검색 UI 동작', JSON.parse(searchUI).open && JSON.parse(searchUI).rows === 1
      && JSON.parse(searchUI).marked === 1, searchUI);
    await evalInPage(ws, "document.querySelector('#search-close').click(); true");

    // ── 설정 화면을 여러 번 그려도 핸들러가 겹치지 않는가 ──
    // (syncSettingsUI 가 불릴 때마다 클릭 핸들러를 새로 붙이던 버그의 재발 방지)
    const dupHandlers = await evalInPage(ws, `
      (() => {
        for (let i = 0; i < 6; i++) syncSettingsUI();
        let n = 0;
        const orig = window.syncSettingsUI;
        window.syncSettingsUI = function (...a) { n++; return orig.apply(this, a); };
        document.querySelector('[data-speed="normal"]').click();
        const speed = n;
        n = 0;
        document.querySelector('[data-vis="always"]').click();
        window.syncSettingsUI = orig;
        return JSON.stringify({ speed, vis: n });
      })()`);
    const dh = JSON.parse(dupHandlers);
    check('설정을 여러 번 그려도 닫기속도 핸들러는 하나', dh.speed === 1, dupHandlers);
    check('설정을 여러 번 그려도 탭보이기 핸들러는 하나', dh.vis === 1, dupHandlers);
    await evalInPage(ws, "saveSettings({ closeSpeed: 'fast', tabVisibility: 'always' }); true");

    // ── 탭 하나씩 자유 배치 + 붙기 ─────────────────────
    const moveTab = await evalInPage(ws, `
      (async () => {
        const els = [...document.querySelectorAll('#tabs .tab')];
        const el = els[0];
        const before = parseFloat(el.style.top);
        const opts = (y) => ({ bubbles: true, clientX: 10, clientY: y, pointerId: 1 });
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent('pointerdown', opts(r.top + 5)));
        el.dispatchEvent(new PointerEvent('pointermove', opts(r.top + 40)));
        el.dispatchEvent(new PointerEvent('pointermove', opts(r.top + 600)));
        el.dispatchEvent(new PointerEvent('pointerup',  opts(r.top + 600)));
        await new Promise(r2 => setTimeout(r2, 300));
        const moved = state.dock.tabs.find(t => t.top != null);
        return JSON.stringify({ before, moved: moved ? Math.round(moved.top * 100) / 100 : null,
                                count: state.dock.tabs.filter(t => t.top != null).length });
      })()`);
    const mv = JSON.parse(moveTab);
    check('탭 하나만 아래로 이동', mv.moved > 0 && mv.count === 1, moveTab);

    const dragOrder = await evalInPage(ws, `
      (() => {
        const els = [...document.querySelectorAll('#tabs .tab')];
        const shown = els.map(el => ({ id: el.dataset.id, y: parseFloat(el.style.top) }))
          .sort((a, b) => a.y - b.y).map(o => o.id);
        return JSON.stringify({ shown, stored: state.dock.tabs.map(t => t.id) });
      })()`);
    const dord = JSON.parse(dragOrder);
    check('끌어 옮긴 뒤 저장 순서가 화면 순서와 같다',
      dord.shown.join() === dord.stored.join(), dragOrder);
    await sleep(500);
    const movedOnDisk = JSON.parse(fs.readFileSync(path.join(PROFILE, 'data.json'), 'utf8'));
    check('탭 위치가 저장됨', movedOnDisk.docks[0].tabs.some((t) => t.top != null),
      JSON.stringify(movedOnDisk.docks[0].tabs.map((t) => t.top)));

    // 다른 탭 가까이 놓으면 딱 붙어야 한다
    const snapped = await evalInPage(ws, `
      (async () => {
        const els = [...document.querySelectorAll('#tabs .tab')];
        const target = els[1];
        const targetTop = parseFloat(target.style.top);
        const wanted = targetTop + target.offsetHeight + 6;   // 딱 붙는 자리
        const el = els[0];
        const r = el.getBoundingClientRect();
        const from = parseFloat(el.style.top);
        const delta = (wanted + 7) - from;                    // 7px 어긋나게 놓는다
        const opts = (y) => ({ bubbles: true, clientX: 10, clientY: y, pointerId: 1 });
        el.dispatchEvent(new PointerEvent('pointerdown', opts(r.top + 5)));
        el.dispatchEvent(new PointerEvent('pointermove', opts(r.top + 5 + 20)));
        el.dispatchEvent(new PointerEvent('pointermove', opts(r.top + 5 + delta)));
        const landed = parseFloat(el.style.top);
        el.dispatchEvent(new PointerEvent('pointerup', opts(r.top + 5 + delta)));
        await new Promise(r2 => setTimeout(r2, 300));
        return JSON.stringify({ wanted, landed });
      })()`);
    const sn = JSON.parse(snapped);
    check('가까이 가면 옆 탭에 딱 붙는다', Math.abs(sn.landed - sn.wanted) < 1, snapped);

    // 다른 탭 위로 끌어도 겹치지 않아야 한다
    const noOverlap = await evalInPage(ws, `
      (async () => {
        const els = [...document.querySelectorAll('#tabs .tab')];
        const victim = els[1];
        const vTop = parseFloat(victim.style.top), vH = victim.offsetHeight;
        const el = els[0], h = el.offsetHeight;
        const r = el.getBoundingClientRect();
        const from = parseFloat(el.style.top);
        const delta = (vTop + 5) - from;            // 정확히 겹치는 자리로 끈다
        const opts = (y) => ({ bubbles: true, clientX: 10, clientY: y, pointerId: 1 });
        el.dispatchEvent(new PointerEvent('pointerdown', opts(r.top + 5)));
        el.dispatchEvent(new PointerEvent('pointermove', opts(r.top + 25)));
        el.dispatchEvent(new PointerEvent('pointermove', opts(r.top + 5 + delta)));
        const landed = parseFloat(el.style.top);
        el.dispatchEvent(new PointerEvent('pointerup', opts(r.top + 5 + delta)));
        await new Promise(r2 => setTimeout(r2, 300));
        await new Promise(r2 => setTimeout(r2, 250));
        const rects = [...document.querySelectorAll('#tabs .tab')]
          .map(x => ({ t: parseFloat(x.style.top), b: parseFloat(x.style.top) + x.offsetHeight }))
          .sort((a, b) => a.t - b.t);
        let overlaps = false;
        for (let i = 1; i < rects.length; i++) if (rects[i].t < rects[i-1].b) overlaps = true;
        return JSON.stringify({ landed, overlaps, rects });
      })()`);
    const ov = JSON.parse(noOverlap);
    check('다른 탭과 겹치지 않는다', ov.overlaps === false, noOverlap);

    // 화면에 보이는 모든 탭이 서로 겹치지 않는지 확인
    const allClear = await evalInPage(ws, `
      (() => {
        const rects = [...document.querySelectorAll('#tabs .tab')]
          .map(el => ({ t: parseFloat(el.style.top), b: parseFloat(el.style.top) + el.offsetHeight }))
          .sort((a, b) => a.t - b.t);
        for (let i = 1; i < rects.length; i++) if (rects[i].t < rects[i-1].b) return false;
        return true;
      })()`);
    check('모든 탭이 서로 안 겹침', allClear === true);

    const resetPos = await evalInPage(ws, `
      resetTabPositions();
      state.dock.tabs.filter(t => t.top != null).length`);
    check('탭 위치 초기화', resetPos === 0, String(resetPos));

    // ＋ 버튼도 탭과 겹치면 안 된다
    const addClear = await evalInPage(ws, `
      (async () => {
        state.dock.tabs[0].top = 0;      // 맨 위를 차지하게 두고
        state.dock.tabs[1].top = 0.5;
        renderTabs();
        await new Promise(r => setTimeout(r, 200));
        const add = document.querySelector('#add-tab');
        const a = { t: parseFloat(add.style.top), b: parseFloat(add.style.top) + add.offsetHeight };
        const hit = [...document.querySelectorAll('#tabs .tab')].some(el => {
          const t = parseFloat(el.style.top), b = t + el.offsetHeight;
          return a.t < b && a.b > t;
        });
        return JSON.stringify({ addTop: a.t, hit });
      })()`);
    check('＋ 버튼이 탭과 안 겹침', JSON.parse(addClear).hit === false, addClear);

    // 끄는 동안 놓일 자리와 밀려나는 이웃이 보여야 한다
    const preview = await evalInPage(ws, `
      (async () => {
        resetTabPositions();
        await new Promise(r => setTimeout(r, 150));
        const els = [...document.querySelectorAll('#tabs .tab')];
        const el = els[2];
        const beforeTops = els.map(x => parseFloat(x.style.top));
        const r = el.getBoundingClientRect();
        const opts = (y) => ({ bubbles: true, clientX: 10, clientY: y, pointerId: 1 });
        el.dispatchEvent(new PointerEvent('pointerdown', opts(r.top + 5)));
        el.dispatchEvent(new PointerEvent('pointermove', opts(r.top - 20)));
        el.dispatchEvent(new PointerEvent('pointermove', opts(r.top - 200)));
        const slot = document.querySelector('#drop-slot');
        const res = {
          slotShown: !slot.hidden,
          slotTop: parseFloat(slot.style.top),
          dragTop: parseFloat(el.style.top),
          neighbourMoved: els.some((x, i) => i !== 2 && parseFloat(x.style.top) !== beforeTops[i]),
        };
        el.dispatchEvent(new PointerEvent('pointerup', opts(r.top - 200)));
        await new Promise(r2 => setTimeout(r2, 300));
        return JSON.stringify(res);
      })()`);
    const pv = JSON.parse(preview);
    check('끄는 동안 놓일 자리가 보인다', pv.slotShown && Math.abs(pv.slotTop - pv.dragTop) < 2, preview);
    check('이웃 탭이 실시간으로 밀린다', pv.neighbourMoved, preview);
    check('놓으면 자리 표시가 사라진다',
      await evalInPage(ws, "document.querySelector('#drop-slot').hidden") === true);

    // 자유 배치를 끄면 순서만 바뀐다
    const orderMode = await evalInPage(ws, `
      (async () => {
        await window.sideMemo.saveSettings({ ...state.settings, freeTabLayout: false });
        state.settings.freeTabLayout = false;
        for (const t of state.dock.tabs) t.top = null;
        renderTabs();
        await new Promise(r => setTimeout(r, 200));
        const before = state.dock.tabs.map(t => t.name);
        const els = [...document.querySelectorAll('#tabs .tab')];
        const el = els[0];
        const r = el.getBoundingClientRect();
        const opts = (y) => ({ bubbles: true, clientX: 10, clientY: y, pointerId: 1 });
        el.dispatchEvent(new PointerEvent('pointerdown', opts(r.top + 5)));
        el.dispatchEvent(new PointerEvent('pointermove', opts(r.top + 30)));
        el.dispatchEvent(new PointerEvent('pointermove', opts(r.top + 200)));
        el.dispatchEvent(new PointerEvent('pointerup', opts(r.top + 200)));
        await new Promise(r2 => setTimeout(r2, 300));
        return JSON.stringify({ before, after: state.dock.tabs.map(t => t.name),
                                allAuto: state.dock.tabs.every(t => t.top == null) });
      })()`);
    const om = JSON.parse(orderMode);
    check('자유 배치 끄면 순서만 바뀐다', om.before[0] !== om.after[0] && om.allAuto, orderMode);
    await evalInPage(ws, `
      (async () => { await window.sideMemo.saveSettings({ ...state.settings, freeTabLayout: true });
                     state.settings.freeTabLayout = true; renderTabs(); })()`);
    await sleep(400);

    // ── 고정(핀) ──────────────────────────────────────
    const pinByDouble = await evalInPage(ws, `
      (async () => {
        const tab = document.querySelector('#tabs .tab');
        tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        return JSON.stringify({
          pinned,
          appClass: document.querySelector('#app').classList.contains('pinned'),
          badge: !document.querySelector('#pin-badge').hidden,
          btn: document.querySelector('#btn-pin').classList.contains('on'),
          toast: document.querySelector('#toast').textContent,
        });
      })()`);
    const pin = JSON.parse(pinByDouble);
    check('탭 더블클릭으로 고정', pin.pinned === true, pinByDouble);
    check('고정 표시 (테두리·배지·버튼)', pin.appClass && pin.badge && pin.btn, pinByDouble);
    check('고정 안내 문구 표시', /고정됨/.test(pin.toast), pin.toast);

    const unpin = await evalInPage(ws, `
      (async () => {
        document.querySelector('#tabs .tab').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        return JSON.stringify({ pinned, appClass: document.querySelector('#app').classList.contains('pinned'),
                                badge: !document.querySelector('#pin-badge').hidden });
      })()`);
    const up = JSON.parse(unpin);
    check('다시 더블클릭하면 고정 해제', up.pinned === false && !up.appClass && !up.badge, unpin);

    const headPin = await evalInPage(ws, `
      (async () => {
        document.querySelector('#panel-head').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        const on = pinned;
        document.querySelector('#panel-head').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        return JSON.stringify({ on, off: pinned });
      })()`);
    check('제목줄 더블클릭으로도 고정', JSON.parse(headPin).on === true && JSON.parse(headPin).off === false, headPin);

    // 메모 본문 더블클릭으로도 고정 (빈 곳일 때만)
    const bodyPin = await evalInPage(ws, `
      (async () => {
        editor.innerHTML = '';
        editor.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        const on = pinned;
        editor.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        return JSON.stringify({ on, off: pinned });
      })()`);
    check('본문 더블클릭으로 고정/해제', JSON.parse(bodyPin).on === true && JSON.parse(bodyPin).off === false, bodyPin);

    // 글자 위든 아래 빈 곳이든 본문이면 어디서나 고정된다
    const anywherePin = await evalInPage(ws, `
      (async () => {
        editor.innerHTML = '<div>단어선택테스트</div>';
        const node = editor.firstChild.firstChild;
        const r = document.createRange(); r.setStart(node, 0); r.setEnd(node, 3);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        editor.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(r2 => setTimeout(r2, 300));
        const onText = pinned;
        editor.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(r2 => setTimeout(r2, 300));
        return JSON.stringify({ onText, off: pinned });
      })()`);
    const ap = JSON.parse(anywherePin);
    check('본문은 글자 위에서도 고정됨', ap.onText === true && ap.off === false, anywherePin);

    // 이미지·첨부파일 위에서는 고정되지 않는다
    const imgNoPin = await evalInPage(ws, `
      (async () => {
        editor.innerHTML = '<img src="x" style="width:40%">';
        const img = editor.querySelector('img');
        img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(r2 => setTimeout(r2, 250));
        return pinned;
      })()`);
    check('이미지 더블클릭은 고정하지 않음', imgNoPin === false, String(imgNoPin));

    // 고정 중에는 탭 한 번 클릭으로 접히지 않는다 (해제가 안 되던 원인)
    const pinnedClick = await evalInPage(ws, `
      (async () => {
        pinned = true; applyPinUI(); await window.sideMemo.setPinned(true);
        app.classList.remove('collapsed'); expanded = true;
        const tab = document.querySelector('#tabs .tab.active') || document.querySelector('#tabs .tab');
        tab.click();
        await new Promise(r => setTimeout(r, 400));
        const stillOpen = !app.classList.contains('collapsed');
        tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        return JSON.stringify({ stillOpen, pinnedAfter: pinned });
      })()`);
    const pc = JSON.parse(pinnedClick);
    check('고정 중 한 번 클릭해도 안 접힘', pc.stillOpen, pinnedClick);
    check('탭 더블클릭으로 고정 해제됨', pc.pinnedAfter === false, pinnedClick);

    // ── 탭 세로 위치 ──────────────────────────────────
    const offset = await evalInPage(ws, `
      (async () => {
        resetTabPositions();
        const before = parseFloat(document.querySelector('#tabs .tab').style.top);
        setTabsOffset(0.5, { save: true });
        await new Promise(r => setTimeout(r, 400));
        return JSON.stringify({ before, after: parseFloat(document.querySelector('#tabs .tab').style.top),
                                value: state.dock.tabsOffset });
      })()`);
    const off = JSON.parse(offset);
    check('자동 배치 탭 전체 내리기', off.before === 0 && off.after > 0, offset);
    await sleep(500);
    const offOnDisk = JSON.parse(fs.readFileSync(path.join(PROFILE, 'data.json'), 'utf8'));
    check('탭 위치가 저장됨', Math.abs(offOnDisk.docks[0].tabsOffset - 0.5) < 0.01,
      String(offOnDisk.docks[0].tabsOffset));

    const clamped = await evalInPage(ws, `
      setTabsOffset(5); setTabsOffset(-3); state.dock.tabsOffset`);
    check('위치 값은 0~1 로 제한', clamped === 0, String(clamped));
    await evalInPage(ws, 'setTabsOffset(0, { save: true }); true');

    // ── 설정 화면이 닫혀버리던 문제 ─────────────────────
    // 확인 창은 패널 안에 그려야 한다. 네이티브 confirm() 은 창 포커스를 뺏어
    // blur → 자동 접힘 → 설정 화면이 닫히는 연쇄를 일으킨다.
    const noNativeModal = await evalInPage(ws, `
      (() => {
        const src = document.querySelector('script[src="renderer.js"]') ? 1 : 1;
        return typeof askConfirm === 'function' && !!document.querySelector('#ask');
      })()`);
    check('패널 안 확인 창이 있다', noNativeModal);

    const askFlow = await evalInPage(ws, `
      (async () => {
        window.openSettingsSheet();
        await new Promise(r => setTimeout(r, 200));
        const p = askConfirm('테스트 질문', { yes: '예' });
        await new Promise(r => setTimeout(r, 200));
        const shown = !document.querySelector('#ask').hidden;
        const settingsStillOpen = !document.querySelector('#settings').hidden;
        document.querySelector('#ask-yes').click();
        const answer = await p;
        return JSON.stringify({ shown, settingsStillOpen, answer,
          hiddenAfter: document.querySelector('#ask').hidden,
          settingsAfter: !document.querySelector('#settings').hidden });
      })()`);
    const af = JSON.parse(askFlow);
    check('확인 창을 띄워도 설정 화면이 열려 있다', af.shown && af.settingsStillOpen, askFlow);
    check('확인 → true 반환하고 닫힌다', af.answer === true && af.hiddenAfter, askFlow);
    check('확인 후에도 설정 화면 유지', af.settingsAfter, askFlow);

    const askCancel = await evalInPage(ws, `
      (async () => {
        const p = askConfirm('취소 테스트');
        await new Promise(r => setTimeout(r, 100));
        document.querySelector('#ask-no').click();
        return await p;
      })()`);
    check('취소 → false 반환', askCancel === false, String(askCancel));

    const askEsc = await evalInPage(ws, `
      (async () => {
        const p = askConfirm('Esc 테스트');
        await new Promise(r => setTimeout(r, 100));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const answer = await p;
        return JSON.stringify({ answer, panelStillOpen: !document.querySelector('#app').classList.contains('collapsed') });
      })()`);
    const ae = JSON.parse(askEsc);
    check('Esc 로 취소되고 패널은 안 닫힘', ae.answer === false && ae.panelStillOpen, askEsc);

    // 휴지통에서 삭제해도 설정 화면이 그대로 있어야 한다 (사용자가 겪은 증상)
    const trashKeepsSettings = await evalInPage(ws, `
      (async () => {
        await removeTab(state.dock.tabs[state.dock.tabs.length - 1].id);
        window.openSettingsSheet();
        await new Promise(r => setTimeout(r, 300));
        document.querySelector('#trash-list .purge').click();
        await new Promise(r => setTimeout(r, 200));
        document.querySelector('#ask-yes').click();
        await new Promise(r => setTimeout(r, 400));
        return JSON.stringify({
          settingsOpen: !document.querySelector('#settings').hidden,
          collapsed: document.querySelector('#app').classList.contains('collapsed'),
          trash: (await window.sideMemo.trashList()).length,
        });
      })()`);
    const tk = JSON.parse(trashKeepsSettings);
    check('휴지통 삭제 후에도 설정 화면 유지', tk.settingsOpen && !tk.collapsed && tk.trash === 0, trashKeepsSettings);
    await evalInPage(ws, "document.querySelector('#settings-close').click(); true");

    // ── 닫히는 속도 ───────────────────────────────────
    const speed = await evalInPage(ws, `
      (async () => {
        const out = {};
        for (const mode of ['instant', 'fast', 'normal']) {
          await window.sideMemo.saveSettings({ ...state.settings, closeSpeed: mode });
          state.settings.closeSpeed = mode;
          applySettings();
          out[mode] = getComputedStyle(document.documentElement).getPropertyValue('--slide-ms').trim();
        }
        await window.sideMemo.saveSettings({ ...state.settings, closeSpeed: 'fast' });
        state.settings.closeSpeed = 'fast'; applySettings();
        return JSON.stringify(out);
      })()`);
    const sp = JSON.parse(speed);
    check('닫히는 속도에 따라 슬라이드 길이가 바뀐다',
      sp.instant === '100ms' && sp.fast === '140ms' && sp.normal === '190ms', speed);

    const speedSaved = await evalInPage(ws, `
      (async () => {
        document.querySelector('[data-speed="instant"]').click();
        await new Promise(r => setTimeout(r, 300));
        return JSON.stringify({ setting: state.settings.closeSpeed,
          on: document.querySelector('[data-speed="instant"]').classList.contains('on') });
      })()`);
    check('닫히는 속도 버튼 동작', JSON.parse(speedSaved).setting === 'instant' && JSON.parse(speedSaved).on, speedSaved);
    await sleep(400);
    const speedOnDisk = JSON.parse(fs.readFileSync(path.join(PROFILE, 'data.json'), 'utf8'));
    check('닫히는 속도가 저장됨', speedOnDisk.settings.closeSpeed === 'instant', speedOnDisk.settings.closeSpeed);

    // ── 탭 숨기기 ─────────────────────────────────────
    const visModes = await evalInPage(ws, `
      (async () => {
        const out = {};
        const cls = () => document.querySelector('#app').classList.contains('tabs-hidden');
        expanded = false;                     // 앞 단계에서 펼쳐둔 상태를 초기화
        pinned = false; applyPinUI();

        state.settings.tabVisibility = 'always'; updateTabVisibility(false); out.always = cls();

        state.settings.tabVisibility = 'hover';
        overStrip = false; updateTabVisibility(false); out.hoverAway = cls();
        overStrip = true;  updateTabVisibility(true);  out.hoverNear = cls();
        overStrip = false;

        state.settings.tabVisibility = 'hidden'; updateTabVisibility(false); out.hidden = cls();

        // 패널이 열려 있으면 어떤 모드든 탭이 보여야 조작할 수 있다
        expanded = true; updateTabVisibility(false); out.hiddenButOpen = cls(); expanded = false;

        state.settings.tabVisibility = 'always'; updateTabVisibility(false);
        return JSON.stringify(out);
      })()`);
    const vm = JSON.parse(visModes);
    check('항상 보이기 모드는 안 숨김', vm.always === false, visModes);
    check('호버 모드: 떨어지면 숨김', vm.hoverAway === true, visModes);
    check('호버 모드: 가장자리에 닿으면 나타남', vm.hoverNear === false, visModes);
    check('숨기기 모드는 평소에 숨김', vm.hidden === true, visModes);
    check('숨겨도 패널이 열리면 탭이 보임', vm.hiddenButOpen === false, visModes);

    const visSaved = await evalInPage(ws, `
      (async () => {
        document.querySelector('[data-vis="hover"]').click();
        await new Promise(r => setTimeout(r, 300));
        return JSON.stringify({ setting: state.settings.tabVisibility,
          on: document.querySelector('[data-vis="hover"]').classList.contains('on') });
      })()`);
    check('탭 보이기 모드 버튼 동작', JSON.parse(visSaved).setting === 'hover' && JSON.parse(visSaved).on, visSaved);
    await sleep(400);
    const visOnDisk = JSON.parse(fs.readFileSync(path.join(PROFILE, 'data.json'), 'utf8'));
    check('탭 보이기 모드가 저장됨', visOnDisk.settings.tabVisibility === 'hover', visOnDisk.settings.tabVisibility);
    await evalInPage(ws, `
      (async () => { document.querySelector('[data-vis="always"]').click();
                     await new Promise(r => setTimeout(r, 200)); })()`);

    // ── 잠시 숨기기 ───────────────────────────────────
    const hidden = await evalInPage(ws, `
      (async () => { await window.sideMemo.hideAll(); await new Promise(r => setTimeout(r, 400)); return true; })()`);
    check('잠시 숨기기 호출됨', hidden === true);
    await sleep(400);
    const stillAlive = (await get('/json/list')).filter((t) => t.type === 'page').length;
    check('숨겨도 앱은 살아 있다 (트레이로 복귀 가능)', stillAlive >= 1, `${stillAlive}개`);

    const shownAgain = await evalInPage(ws, `
      (async () => {
        // 숨김 상태에서 '열기' 단축키를 누른 것과 같은 경로
        await window.sideMemo.setPanel(true, { focus: false });
        await new Promise(r => setTimeout(r, 400));
        return !document.querySelector('#app').classList.contains('collapsed');
      })()`);
    check('숨김 상태에서도 다시 부를 수 있다', shownAgain === true, String(shownAgain));

    const hideShortcut = await evalInPage(ws, `
      (async () => (await window.sideMemo.getState()).settings.shortcuts.hideAll)()`);
    check('숨기기 단축키 기본값', hideShortcut === 'Control+Alt+H', String(hideShortcut));

    // ── F5 날짜/시간 ──────────────────────────────────
    const f5 = await evalInPage(ws, `
      (async () => {
        document.querySelector('#settings').hidden = true;
        document.querySelector('#search').hidden = true;
        editor.innerHTML = '';
        expanded = true;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        const both = editor.textContent;
        editor.innerHTML = '';
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', shiftKey: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        const dateOnly = editor.textContent;
        editor.innerHTML = '';
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', ctrlKey: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        const timeOnly = editor.textContent;
        editor.innerHTML = '';
        return JSON.stringify({ both, dateOnly, timeOnly });
      })()`);
    const st = JSON.parse(f5);
    const dateRe = /\d{4}-\d{2}-\d{2} \([일월화수목금토]\)/;
    const timeRe = /(오전|오후) \d{1,2}:\d{2}/;
    check('F5 로 날짜+시간 삽입', dateRe.test(st.both) && timeRe.test(st.both), st.both);
    check('Shift+F5 는 날짜만', dateRe.test(st.dateOnly) && !timeRe.test(st.dateOnly), st.dateOnly);
    check('Ctrl+F5 는 시간만', timeRe.test(st.timeOnly) && !dateRe.test(st.timeOnly), st.timeOnly);

    const f5Blocked = await evalInPage(ws, `
      (async () => {
        editor.innerHTML = '';
        window.openSettingsSheet();
        await new Promise(r => setTimeout(r, 200));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        const text = editor.textContent;
        document.querySelector('#settings-close').click();
        return text;
      })()`);
    check('설정 화면이 열려 있으면 F5 무시', f5Blocked === '', JSON.stringify(f5Blocked));

    // ── 기능 안내 ─────────────────────────────────────
    const help = await evalInPage(ws, `
      (() => {
        const el = document.querySelector('#help');
        return JSON.stringify({
          exists: !!el,
          collapsed: !el.open,
          sections: el.querySelectorAll('h4').length,
          keysFilled: [...el.querySelectorAll('[data-help-sc]')].every(x => x.textContent.trim().length > 0),
          keyText: el.querySelector('[data-help-sc="toggle"]').textContent,
        });
      })()`);
    const hp = JSON.parse(help);
    check('설정 맨 위에 기능 안내가 있다', hp.exists && hp.sections >= 7, help);
    check('안내는 접힌 채로 시작', hp.collapsed, help);
    check('안내의 단축키가 실제 설정값으로 채워짐', hp.keysFilled && /Ctrl/.test(hp.keyText), hp.keyText);

    // ── 서식 / 링크 ───────────────────────────────────
    const bold = await evalInPage(ws, `
      editor.innerHTML = '터ㅅ트';
      const r = document.createRange(); r.selectNodeContents(editor);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      exec('bold'); /<(b|strong)>/.test(editor.innerHTML)`);
    check('굵게 서식 적용', bold);

    // ── 렌더러 오류 ───────────────────────────────────
    const errors = logs.join('').match(/\[renderer\].*(Uncaught|Error)/g);
    check('렌더러 오류 없음', !errors, errors ? errors.join(' / ') : '');
  } catch (err) {
    check('테스트 실행 중 예외', false, err.message);
  }

  ws.close();
  child.kill();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 통과`);
  // 방금 종료한 프로세스가 파일을 아직 붙들고 있을 수 있다. 지우지 못해도 테스트 결과에는 영향 없다.
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 임시 폴더라 남아도 무방 */ }
  process.exit(failed.length ? 1 : 0);
})();
