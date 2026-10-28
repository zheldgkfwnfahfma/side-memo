const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog,
  nativeImage, shell, protocol, net, globalShortcut, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { pickDisplay, hintOf, refreshDocks, isWaiting, confirmableId } = require('./displays');
const { createShare, htmlToText, safeFileName, uniqueStoredName } = require('./share');
const { createUpdater } = require('./updater');

const TAB_W = 34;              // 화면 가장자리에 항상 남아 있는 탭 스트립 폭
// 커서가 벗어난 뒤 접히기까지의 유예(ms). 설정에서 고른다.
const HIDE_DELAY = { instant: 0, fast: 110, normal: 320 };
const CURSOR_POLL_MS = 40;     // 커서 위치를 보는 주기. 짧을수록 반응이 빠르다
const MIN_PANEL_W = 260;
const MAX_PANEL_W = 900;
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
// 클릭 한 번으로 실행되면 곤란한 확장자. 열기 전에 한 번 더 확인한다.
const EXECUTABLE_EXTS = [
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.msi', '.msp', '.scr', '.cpl', '.hta', '.reg', '.lnk', '.jar',
];
const DEV = process.argv.includes('--dev');

let store;
let share;
let tray = null;
let watchTimer = null;
let quitting = false;
let lastActiveDockId = null;   // 단축키가 어느 가장자리를 대상으로 할지
let modalCount = 0;            // 파일 선택 같은 네이티브 창이 떠 있는 개수
let hiddenAll = false;         // '잠시 숨기기' — 창을 통째로 감춘 상태

/*
 * 파일·폴더 선택 창이 뜨면 메모지 창은 포커스를 잃는다.
 * 그때 자동으로 접어버리면 사용자가 파일을 고르고 돌아왔을 때 메모지가 사라져 있다.
 * 그래서 모달이 떠 있는 동안에는 접지 않는다.
 */
async function withModal(fn) {
  modalCount++;
  try { return await fn(); } finally { modalCount--; }
}

/**
 * 가장자리(dock) 하나 = 창 하나. 창마다 여닫힘 상태를 따로 들고 있다.
 * key: dockId, value: { win, expanded, pinned, interactive, activeWidth, outsideSince, resizing }
 */
const panes = new Map();

/*
 * productName 이 한글이라 저장 폴더까지 한글이 되지 않도록 경로를 직접 지정한다.
 * 단 --user-data-dir 로 프로필을 따로 준 경우(테스트 등)에는 그쪽을 존중한다.
 * 그러지 않으면 테스트가 실제 메모를 건드린다.
 */
const customProfile = process.argv.find((a) => a.startsWith('--user-data-dir='));
const USER_DATA = customProfile
  ? customProfile.slice('--user-data-dir='.length)
  : path.join(app.getPath('appData'), 'side-memo');
app.setPath('userData', USER_DATA);

/*
 * 메모 데이터가 실제로 저장되는 폴더.
 * 기본은 userData 지만, 설정에서 OneDrive 같은 곳으로 옮길 수 있다.
 * 옮긴 경로는 userData/location.json 에 남긴다(데이터 파일 자체가 이동하므로).
 */
const LOCATION_FILE = path.join(USER_DATA, 'location.json');

function defaultDataDir() {
  return USER_DATA;
}

function readDataDir() {
  try {
    const dir = JSON.parse(fs.readFileSync(LOCATION_FILE, 'utf8')).dir;
    if (dir && fs.existsSync(dir)) return dir;
  } catch { /* 없으면 기본값 */ }
  return defaultDataDir();
}

function writeDataDir(dir) {
  if (dir === defaultDataDir()) {
    try { fs.unlinkSync(LOCATION_FILE); } catch { /* 원래 없을 수 있다 */ }
  } else {
    fs.writeFileSync(LOCATION_FILE, JSON.stringify({ dir }, null, 2), 'utf8');
  }
}

/** 이전 이름(peekpad)으로 저장해둔 메모가 있으면 한 번만 옮겨온다. */
function migrateOldProfile() {
  if (customProfile) return;   // 테스트용 프로필에는 옛 데이터를 끌어오지 않는다
  const oldDir = path.join(app.getPath('appData'), 'peekpad');
  const oldFile = path.join(oldDir, 'data.json');
  const newFile = path.join(USER_DATA, 'data.json');
  if (fs.existsSync(newFile) || !fs.existsSync(oldFile)) return;

  const newImages = path.join(USER_DATA, 'images');
  fs.mkdirSync(newImages, { recursive: true });
  fs.writeFileSync(newFile, fs.readFileSync(oldFile, 'utf8').split('peekpad-img://').join('sidememo-img://'), 'utf8');

  const oldImages = path.join(oldDir, 'images');
  if (fs.existsSync(oldImages)) {
    for (const name of fs.readdirSync(oldImages)) {
      fs.copyFileSync(path.join(oldImages, name), path.join(newImages, name));
    }
  }
  console.log('이전 메모를 side-memo 로 옮겼습니다.');
}

// 이미지를 file:// 대신 전용 스킴으로 넘긴다. 렌더러가 임의 로컬 파일에 접근하지 못한다.
protocol.registerSchemesAsPrivileged([
  { scheme: 'sidememo-img', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ---------------------------------------------------------------- 모니터 / 창 배치

/*
 * 모니터 목록. 테스트(임시 프로필)에서는 모니터를 끄고 켜는 상황을 흉내 낼 수 있도록
 * 가짜 목록으로 바꿔 끼울 수 있다. 실제 실행에서는 늘 진짜 목록이다.
 */
let fakeDisplays = null;
function allDisplays() { return fakeDisplays ? fakeDisplays.list : screen.getAllDisplays(); }
function primaryDisplayId() { return fakeDisplays ? fakeDisplays.primaryId : screen.getPrimaryDisplay().id; }

/*
 * 모니터 배치가 가라앉았는지.
 * 잠금·절전에서 깨어나는 몇 초 동안 윈도우는 배치를 잠깐 이상하게 보고한다
 * (주 모니터가 늦게 켜져 오른쪽 모니터 혼자 x=0 에 잡히는 식). 그동안엔 창을 옮기거나
 * 번호를 확인하지 않고, 배치가 SETTLE_MS 동안 그대로일 때 비로소 맞춘다.
 */
let SETTLE_MS = 3000;
let topologyKey = '';
let topologyChangedAt = Date.now();   // 막 켜진 직후도 '흔들리는 중'으로 본다

function noteTopology() {
  const key = allDisplays()
    .map((d) => `${d.id}@${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}`)
    .sort().join('|') + '#' + primaryDisplayId();
  if (key === topologyKey) return false;
  topologyKey = key;
  topologyChangedAt = Date.now();
  return true;
}

function settled() {
  return Date.now() - topologyChangedAt >= SETTLE_MS;
}

/*
 * 이번 실행 중 '이 가장자리는 이 모니터'라고 확인된 번호.
 * 배치는 흔들려도 번호는 그대로라, 깨어나는 동안엔 좌표보다 이걸 믿는다. 저장하지 않는다.
 */
const sessionIds = new Map();

/* 모니터 id 는 재부팅하면 바뀔 수 있다. 찾는 규칙은 displays.js 에 있다. */
function resolveDisplay(dock) {
  return pickDisplay(allDisplays(), primaryDisplayId(), dock, {
    sessionId: sessionIds.has(dock.id) ? sessionIds.get(dock.id) : null,
    settled: settled(),
  });
}

function displayFor(dock) {
  return resolveDisplay(dock).display;
}

/** 저장된 모니터 정보를 지금 화면에 맞춰 고쳐 적는다. 규칙은 displays.js 의 refreshDocks. */
function refreshDockDisplays() {
  const changed = refreshDocks(store.get().docks, allDisplays(), primaryDisplayId(), { settled: settled() });
  if (changed) store.save();
  return changed;
}

/**
 * 자리가 겹치는지는 '실제로 붙어 있는 모니터' 기준으로 본다. null 은 주 모니터다.
 * 모니터가 꺼져 기다리는 가장자리는 그 모니터 자리를 지키고 있는 것으로 본다.
 */
function isSpotTaken(displayId, edge, exceptId = null) {
  const target = displayId == null ? primaryDisplayId() : displayId;
  const where = (d) => {
    const r = resolveDisplay(d);
    return isWaiting(r) ? `off:${d.displayId}` : r.display.id;
  };
  return store.get().docks.some((d) => d.id !== exceptId && d.edge === edge && where(d) === target);
}

function displayList() {
  const primaryId = primaryDisplayId();
  return allDisplays().map((d, i) => ({
    id: d.id,
    isPrimary: d.id === primaryId,
    label: `모니터 ${i + 1} · ${d.size.width}×${d.size.height}${d.id === primaryId ? ' (주)' : ''}`,
  }));
}

/** 지금 화면에 적용 중인 폭. 메모마다 폭을 따로 둘 수 있어서 설정값과 분리해 둔다. */
function effectiveWidth(pane) {
  return pane.activeWidth != null ? pane.activeWidth : store.get().settings.panelWidth;
}

/**
 * 창은 항상 같은 자리(가장자리에 붙은 세로 띠)에 머무르고, 미끄러지는 건 CSS 안쪽의 패널이다.
 * 창을 움직이지 않으니 애니메이션이 부드럽고, 접혀 있을 땐 클릭이 그대로 통과한다.
 */
function boundsFor(dock, panelW) {
  const wa = displayFor(dock).workArea;
  const total = TAB_W + Math.round(panelW);
  const x = dock.edge === 'right' ? wa.x + wa.width - total : wa.x;
  return { x: Math.round(x), y: wa.y, width: total, height: wa.height };
}

const differs = (a, b) => Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2
                      || Math.abs(a.width - b.width) > 2 || Math.abs(a.height - b.height) > 2;

/*
 * 가장자리 하나를 지금 모니터 상태에 맞게 둔다.
 *
 *  - 고른 모니터가 꺼져 있으면(윈도우 목록에서 사라졌으면) 창을 숨기고 기다린다.
 *    예전에는 주 모니터로 옮겨 붙였는데, 모니터를 끌 때마다 메모가 주 모니터로 넘어왔다.
 *  - 그동안 트레이·단축키로 직접 부르면(peek) 그때만 주 모니터에 잠깐 꺼내 보인다.
 *  - 모니터가 돌아오면 원래 자리에 다시 나타난다.
 *
 * 모니터 알림이 올 때와 1.5초마다 한 번씩 불린다. 알림을 놓쳐도 결국 맞는 상태가 된다.
 */
function reposition(dockId) {
  const pane = panes.get(dockId);
  const dock = store.getDock(dockId);
  if (!pane || !dock || pane.win.isDestroyed()) return;

  const result = resolveDisplay(dock);
  const waiting = isWaiting(result);
  if (!waiting) pane.peek = false;          // 모니터가 돌아왔으면 잠깐 꺼내 보기는 끝

  if (waiting && !pane.peek) {
    if (!pane.waiting) {
      pane.waiting = true;
      if (pane.expanded) slideTo(dockId, false);
      if (pane.win.isVisible()) pane.win.hide();
      refreshTrayMenu();
    }
    return;
  }
  // 배치가 흔들리는 중이면 옮기지도 띄우지도 않는다. 잠깐 뒤 가라앉으면 그때 맞춘다.
  // (숨기기는 위에서 바로 했다. 직접 불러낸 경우는 기다리지 않는다)
  if (!settled() && !pane.peek) return;

  const sure = confirmableId(result, allDisplays(), dock, true);
  if (sure != null) sessionIds.set(dockId, sure);

  if (pane.waiting) {
    pane.waiting = false;
    refreshTrayMenu();
  }

  if (!pane.resizing) {   // 모서리를 끄는 중에 창 크기를 되돌리면 드래그가 끊긴다
    const want = boundsFor(dock, effectiveWidth(pane));
    if (differs(want, pane.win.getBounds())) pane.win.setBounds(want);
  }
  if (pane.ready && !hiddenAll && !pane.win.isVisible()) {
    pane.win.showInactive();
    pane.interactive = null;                // 숨어 있던 동안의 상태는 믿지 않는다
    setInteractive(pane, !!pane.expanded);
  }
}

function repositionAll() {
  for (const id of panes.keys()) reposition(id);
}

/** 접혀 있을 땐 탭 위에서만 클릭을 받고, 나머지 영역은 아래 창으로 흘려보낸다. */
function setInteractive(pane, next) {
  if (!pane || pane.win.isDestroyed() || next === pane.interactive) return;
  pane.interactive = next;
  pane.win.setIgnoreMouseEvents(!next, { forward: true });
}

function slideTo(dockId, isExpanded, opts = {}) {
  const pane = panes.get(dockId);
  if (!pane || pane.win.isDestroyed()) return;

  // 모니터가 꺼져 숨어 있는 가장자리를 트레이·단축키로 부르면, 그동안만 주 모니터에 꺼내 보인다.
  // 다른 곳을 눌러 닫힐 때까지 열려 있도록 포커스를 준다.
  if (isExpanded && pane.waiting) {
    pane.peek = true;
    reposition(dockId);
    opts = { ...opts, focus: true };
  }

  const mode = store.get().settings.closeMode;
  // '다른 창 클릭 시 닫기' 모드는 blur 이벤트가 있어야 하므로 열 때 포커스를 가져온다.
  const focus = opts.focus !== undefined ? opts.focus : mode === 'focus';

  if (DEV) console.log('[slide]', dockId, isExpanded ? 'expand' : 'collapse');
  pane.expanded = isExpanded;
  pane.outsideSince = 0;
  if (isExpanded) lastActiveDockId = dockId;
  setInteractive(pane, isExpanded);
  pane.win.webContents.send('panel:state', { expanded: isExpanded });
  if (isExpanded && focus) pane.win.focus();
  if (!isExpanded && pane.win.isFocused()) pane.win.blur();

  // 잠깐 꺼내 본 것이었으면, 닫을 때 모니터가 아직 꺼져 있으면 다시 숨는다
  if (!isExpanded && pane.peek) {
    pane.peek = false;
    reposition(dockId);
  }
}

// ---------------------------------------------------------------- 창

function createPane(dock) {
  const win = new BrowserWindow({
    ...boundsFor(dock, store.get().settings.panelWidth),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  const pane = {
    win, dockId: dock.id,
    expanded: false, pinned: false, interactive: false, overStrip: false,
    activeWidth: null, outsideSince: 0, resizing: false,
  };
  panes.set(dock.id, pane);

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    pane.ready = true;
    win.setIgnoreMouseEvents(true, { forward: true });
    reposition(dock.id);              // 보일 자리면 띄운다 (포커스는 빼앗지 않는다). 꺼진 모니터면 기다린다
  });

  // 렌더러가 죽거나 CSP에 막히면 투명 창이라 아무것도 안 보인다. 원인을 콘솔로 남긴다.
  if (DEV) {
    win.webContents.on('console-message', (_e, _level, message, line, source) => {
      console.log(`[renderer] ${message} (${source}:${line})`);
    });
  }
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('[load-failed]', code, desc, url));
  win.webContents.on('render-process-gone', (_e, details) => console.error('[renderer-gone]', details));

  win.on('focus', () => { lastActiveDockId = dock.id; });

  win.on('blur', () => {
    // 'manual' 을 뺀 모든 모드에서, 다른 창으로 포커스가 넘어가면 접는다.
    if (pane.resizing || pane.pinned || modalCount) return;
    if (store.get().settings.closeMode !== 'manual') slideTo(dock.id, false);
  });

  win.on('close', (e) => {
    // 창을 닫아도 트레이에 남는다. 종료는 트레이 메뉴로만.
    if (!quitting) { e.preventDefault(); slideTo(dock.id, false); }
  });

  // 메모 안의 링크는 기본 브라우저로 연다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  if (!lastActiveDockId) lastActiveDockId = dock.id;
  return pane;
}

function destroyPane(dockId) {
  const pane = panes.get(dockId);
  if (!pane) return;
  panes.delete(dockId);
  if (!pane.win.isDestroyed()) { quitting = true; pane.win.destroy(); quitting = false; }
  if (lastActiveDockId === dockId) lastActiveDockId = panes.keys().next().value || null;
}

/*
 * 커서가 창 밖으로 나갔는지는 메인에서 직접 본다.
 * 렌더러의 mouseleave 는 호버로 열렸을 때(포커스 없음)나 다른 창이 위로 올라올 때 놓치는 경우가 있다.
 */
function startCursorWatch() {
  clearInterval(watchTimer);
  watchTimer = setInterval(() => {
    if (hiddenAll) return;
    const p = screen.getCursorScreenPoint();
    const mode = store.get().settings.closeMode;
    const visibility = store.get().settings.tabVisibility || 'always';

    for (const [dockId, pane] of panes) {
      if (pane.win.isDestroyed() || !pane.win.isVisible()) continue;
      const dock = store.getDock(dockId);
      if (!dock) continue;
      const b = pane.win.getBounds();

      /*
       * 커서가 탭 띠 위에 있는지.
       * 창이 클릭을 통과시키는 동안 렌더러의 mousemove 는 창 밖에서 끊기기 때문에,
       * '가장자리에 마우스를 댈 때만' 모드를 위해 여기서 직접 본다.
       */
      const stripX = dock.edge === 'right' ? b.x + b.width - TAB_W : b.x;
      const overStrip = p.x >= stripX - 2 && p.x <= stripX + TAB_W + 2
                     && p.y >= b.y && p.y <= b.y + b.height;
      if (overStrip !== pane.overStrip) {
        pane.overStrip = overStrip;
        pane.win.webContents.send('panel:edgeHover', overStrip);
        // 숨어 있는 탭은 클릭도 받지 않아야 아래 창이 정상적으로 눌린다
        if (visibility !== 'always' && !pane.expanded && !pane.tabDragging) setInteractive(pane, overStrip);
      }

      // ── 자동 접힘 ──
      if (mode !== 'mouse') continue;
      // 탭을 끌고 나가는 중에 접어버리면 끌기가 끊긴다
      if (!pane.expanded || pane.pinned || pane.resizing || pane.tabDragging || modalCount) continue;
      if (pane.win.isFocused()) { pane.outsideSince = 0; continue; }   // 메모를 편집 중이면 유지

      const inside = p.x >= b.x - 2 && p.x <= b.x + b.width + 2
                  && p.y >= b.y - 2 && p.y <= b.y + b.height + 2;
      if (inside) { pane.outsideSince = 0; continue; }

      const grace = HIDE_DELAY[store.get().settings.closeSpeed] ?? HIDE_DELAY.fast;
      if (!pane.outsideSince) pane.outsideSince = Date.now();
      if (Date.now() - pane.outsideSince >= grace) slideTo(dockId, false);
    }

    // 탭을 다른 가장자리로 끌고 가는 중이면, 놓을 수 있는 곳을 밝혀 준다
    const dragging = [...panes.values()].find((x) => x.tabDragging);
    showDropTarget(dragging ? dropTargetAt(p, dragging.dockId) : null);
  }, CURSOR_POLL_MS);
}

/*
 * ─── 가장자리 사이로 메모 옮기기 ───
 * 가장자리마다 창이 따로라서, 탭을 끌고 나간 커서가 어느 가장자리의 띠 위에 있는지는
 * 메인이 직접 본다. 띠는 34px 로 좁아서 화면 안쪽으로 조금 넉넉하게 잡아 준다.
 */
const DROP_SLACK = 60;

function dropTargetAt(p, exceptDockId) {
  for (const [dockId, pane] of panes) {
    if (dockId === exceptDockId || pane.win.isDestroyed() || !pane.win.isVisible()) continue;
    const dock = store.getDock(dockId);
    if (!dock) continue;
    const b = pane.win.getBounds();
    const left = dock.edge === 'right' ? b.x + b.width - TAB_W - DROP_SLACK : b.x;
    const right = dock.edge === 'right' ? b.x + b.width : b.x + TAB_W + DROP_SLACK;
    if (p.x >= left && p.x <= right && p.y >= b.y && p.y <= b.y + b.height) return pane;
  }
  return null;
}

let dropTargetDockId = null;

function showDropTarget(pane) {
  const id = pane ? pane.dockId : null;
  if (id === dropTargetDockId) return;
  const prev = dropTargetDockId && panes.get(dropTargetDockId);
  if (prev && !prev.win.isDestroyed()) prev.win.webContents.send('tabs:dropTarget', false);
  if (pane && !pane.win.isDestroyed()) pane.win.webContents.send('tabs:dropTarget', true);
  dropTargetDockId = id;
}

/*
 * ─── 창이 제자리에 있는지 지켜보기 ───
 * 모니터가 절전에 들어갔다 깨거나 연결이 잠깐 끊기면 윈도우가 창을 다른 화면으로 옮긴다.
 * 돌아올 때 '모니터 바뀜' 알림이 오면 제자리로 돌려놓지만, 그 알림을 놓치면 엉뚱한 화면에
 * 그대로 남았다. 알림에만 기대지 않고 주기적으로 맞는 자리인지 확인해서 바로잡는다.
 */
const PLACEMENT_CHECK_MS = 1500;
const PLACEMENT_LOG_MAX = 64 * 1024;
let placementTimer = null;

function startPlacementWatch() {
  clearInterval(placementTimer);
  placementTimer = setInterval(() => {
    if (hiddenAll) return;
    // 모니터 알림을 놓쳤어도 여기서 따라잡는다. 배치가 바뀐 걸 여기서 처음 알았으면
    // 알림이 온 것과 똑같이 처리한다 (가라앉는 즉시 맞추도록 예약까지).
    if (noteTopology()) { handleDisplaysChanged(); return; }
    refreshDockDisplays();
    for (const [dockId, pane] of panes) {
      if (pane.win.isDestroyed() || pane.resizing) continue;
      const dock = store.getDock(dockId);
      if (!dock) continue;
      const waiting = isWaiting(resolveDisplay(dock));
      if (settled() && !waiting && !pane.waiting && pane.win.isVisible()) {
        const want = boundsFor(dock, effectiveWidth(pane));
        const got = pane.win.getBounds();
        if (differs(want, got)) logPlacement(dock, want, got);
      }
      reposition(dockId);
    }
  }, PLACEMENT_CHECK_MS);
}

/** 모니터를 켜고 끄거나 배치를 바꿨을 때. */
let settleTimer = null;

function handleDisplaysChanged() {
  noteTopology();
  refreshDockDisplays();
  repositionAll();
  // 가라앉으면 바로 제자리로 (1.5초 감시를 기다리지 않는다)
  clearTimeout(settleTimer);
  settleTimer = setTimeout(handleDisplaysChanged, Math.max(0, SETTLE_MS - (Date.now() - topologyChangedAt)) + 100);
  if (settled()) clearTimeout(settleTimer);
  broadcastDocks();
  for (const pane of panes.values()) {
    if (!pane.win.isDestroyed()) pane.win.webContents.send('displays:changed', displayList());
  }
}

/** 언제 왜 밀려났는지 나중에 알 수 있게 짧게 남긴다 (userData/placement.log). */
function logPlacement(dock, want, got) {
  try {
    const file = path.join(USER_DATA, 'placement.log');
    const displays = allDisplays()
      .map((d) => `${d.id}@${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height}`).join(' | ');
    const line = `${new Date().toISOString()} ${dockLabel(dock)} 기대 ${JSON.stringify(want)} `
               + `실제 ${JSON.stringify(got)} 모니터 [${displays}]\n`;
    if (fs.existsSync(file) && fs.statSync(file).size > PLACEMENT_LOG_MAX) {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(-PLACEMENT_LOG_MAX / 2), 'utf8');
    }
    fs.appendFileSync(file, line, 'utf8');
  } catch { /* 기록 실패는 무시한다 */ }
}

// ---------------------------------------------------------------- 트레이

function dockLabel(dock) {
  const side = dock.edge === 'right' ? '오른쪽' : '왼쪽';
  const r = resolveDisplay(dock);
  if (isWaiting(r)) return `꺼진 모니터 · ${side}`;
  const displays = displayList();
  const i = displays.findIndex((d) => d.id === r.display.id);
  return displays.length > 1 ? `모니터 ${i + 1} · ${side}` : side;
}

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon-16.png'));
  tray = new Tray(icon);
  tray.setToolTip('사이드 메모');
  refreshTrayMenu();
  tray.on('click', () => toggleDock(lastActiveDockId));
  tray.on('double-click', () => openSettings(lastActiveDockId));
}

function refreshTrayMenu() {
  if (!tray) return;
  const s = store.get().settings;
  const docks = store.get().docks;

  tray.setContextMenu(Menu.buildFromTemplate([
    ...docks.map((dock) => ({
      label: `${dockLabel(dock)} 메모${(panes.get(dock.id) || {}).waiting ? ' (켜지면 다시 나타남)' : ''}`,
      submenu: [
        { label: '열기 / 닫기', click: () => toggleDock(dock.id) },
        { label: '설정…', click: () => openSettings(dock.id) },
        {
          label: '항상 펼쳐두기(고정)',
          type: 'checkbox',
          checked: !!(panes.get(dock.id) || {}).pinned,
          click: (item) => setPinned(dock.id, item.checked),
        },
      ],
    })),
    ...(updater && updater.state().status === 'ready'
      ? [{ type: 'separator' }, { label: `업데이트 적용 (${updater.state().version})…`, click: () => openUpdate() }]
      : []),
    { type: 'separator' },
    {
      label: '잠시 숨기기', type: 'checkbox', checked: hiddenAll,
      click: (item) => setHiddenAll(item.checked),
    },
    {
      label: '윈도우 시작 시 실행', type: 'checkbox', checked: s.launchOnStartup,
      click: (item) => {
        store.get().settings.launchOnStartup = item.checked;
        store.save();
        app.setLoginItemSettings({ openAtLogin: item.checked });
        broadcastSettings();
      },
    },
    { type: 'separator' },
    { label: '종료', click: () => quitApp() },
  ]));
}

/*
 * ─── 끄기 전에 메모 저장 ───
 * 렌더러는 글자를 치고 0.4초 뒤에 저장한다. 그 사이에 앱을 끄거나 업데이트로 다시 켜면
 * 마지막 몇 글자가 날아갈 수 있다. 모든 창에 '지금 저장'을 시키고 끝났다는 답을 기다린다.
 */
let flushSeq = 0;
const flushWaiters = new Map();

function flushAll(timeoutMs = 3000) {
  const jobs = [];
  for (const pane of panes.values()) {
    if (pane.win.isDestroyed()) continue;
    const id = ++flushSeq;
    jobs.push(new Promise((resolve) => {
      const timer = setTimeout(() => { flushWaiters.delete(id); resolve(false); }, timeoutMs);
      flushWaiters.set(id, () => { clearTimeout(timer); flushWaiters.delete(id); resolve(true); });
      pane.win.webContents.send('app:flush', id);
    }));
  }
  return Promise.all(jobs);
}

async function quitApp() {
  await flushAll();
  quitting = true;
  app.quit();
}

/*
 * ─── 업데이트 ───
 * 확인하는 곳은 GitHub 의 이 앱 릴리스 주소 하나뿐이다 (updater.js 참고).
 * 포장된 앱(설치본)에서만 켠다. 테스트에서는 가짜 서버를 바라보게 한다.
 */
let updater = null;
let forceBusy = null;   // 테스트 전용: '메모를 쓰는 중'을 강제로 정한다 (창 포커스는 테스트에서 믿을 수 없다)
const testUpdateFeed = customProfile
  && (process.argv.find((a) => a.startsWith('--update-feed=')) || '').slice('--update-feed='.length);

function broadcastUpdate() {
  const st = updater ? updater.state() : { status: 'off', current: app.getVersion() };
  for (const pane of panes.values()) {
    if (!pane.win.isDestroyed()) pane.win.webContents.send('update:state', st);
  }
}

/** 업데이트 화면을 연다 (알림·트레이에서 눌렀을 때). */
function openUpdate() {
  const id = lastActiveDockId || (panes.keys().next().value);
  const pane = panes.get(id);
  if (!pane) return;
  slideTo(id, true, { focus: true });
  pane.win.webContents.send('ui:open-update');
}

function startUpdater() {
  if (!app.isPackaged && !testUpdateFeed) return;   // 개발 중에는 끈다
  let test = null;
  if (testUpdateFeed) {
    const configPath = path.join(USER_DATA, 'test-app-update.yml');
    fs.writeFileSync(configPath,
      `provider: generic\nurl: ${testUpdateFeed}\nupdaterCacheDirName: side-memo-updater-test\n`, 'utf8');
    test = { feedUrl: testUpdateFeed, configPath };
  }
  updater = createUpdater({
    getSettings: () => store.get().settings,
    // 메모를 펼쳐 놓고 있으면 정한 시각이 돼도 끊지 않는다
    isBusy: () => (forceBusy != null ? forceBusy
      : [...panes.values()].some((p) => p.expanded && !p.win.isDestroyed() && p.win.isFocused())),
    beforeInstall: () => flushAll(),
    onChange: () => { broadcastUpdate(); refreshTrayMenu(); },
    onReady: (st) => {
      if (!Notification.isSupported()) return;
      const s = store.get().settings;
      const body = s.updateMode === 'time' && st.applyAt
        ? `${new Date(st.applyAt).toTimeString().slice(0, 5)} 에 적용됩니다. 눌러서 바꿀 수 있습니다.`
        : '눌러서 지금 적용하거나 적용할 시간을 고르세요.';
      const n = new Notification({ title: `사이드 메모 ${st.version} 이(가) 준비됐습니다`, body, silent: false });
      n.on('click', () => openUpdate());
      n.show();
    },
    test,
  });
  updater.start();
}

function toggleDock(dockId) {
  const pane = panes.get(dockId) || panes.values().next().value;
  if (pane) slideTo(pane.dockId, !pane.expanded);
}

function openSettings(dockId) {
  const pane = panes.get(dockId) || panes.values().next().value;
  if (!pane) return;
  slideTo(pane.dockId, true, { focus: true });
  pane.win.webContents.send('ui:open-settings');
}

function setPinned(dockId, value) {
  const pane = panes.get(dockId);
  if (!pane) return false;
  pane.pinned = !!value;
  pane.win.webContents.send('panel:pin', pane.pinned);
  refreshTrayMenu();
  if (pane.pinned) slideTo(dockId, true);
  return pane.pinned;
}

/** 저장 위치가 바뀌는 등 데이터가 통째로 갈릴 때 모든 창을 다시 그리게 한다. */
function reloadAllWindows() {
  for (const pane of panes.values()) {
    if (!pane.win.isDestroyed()) pane.win.webContents.send('state:reload', {});
  }
}

/**
 * 메모지를 화면에서 통째로 감춘다. 트레이 아이콘과 단축키는 그대로 살아 있어서
 * 언제든 다시 불러올 수 있다.
 */
function setHiddenAll(next) {
  hiddenAll = !!next;
  for (const [dockId, pane] of panes) {
    if (pane.win.isDestroyed()) continue;
    if (hiddenAll) {
      slideTo(dockId, false);
      pane.win.hide();
    } else {
      setInteractive(pane, false);
      reposition(dockId);             // 띄울 자리면 띄우고, 꺼진 모니터면 계속 기다린다
    }
  }
  refreshTrayMenu();
  return hiddenAll;
}

/**
 * data.json 이 깨져 있었다면 조용히 넘어가지 않는다.
 * 사용자가 '메모가 다 없어졌다'고 느끼기 전에 무슨 일이 있었는지 알려준다.
 */
function reportRecovery() {
  if (store.recoveredFrom) {
    withModal(() => dialog.showMessageBox({
      type: 'warning',
      buttons: ['확인'],
      message: '메모 파일이 손상되어 백업에서 되살렸습니다.',
      detail: [
        `되살린 백업: ${store.recoveredFrom}`,
        '',
        '그 뒤에 쓴 내용은 빠져 있을 수 있습니다.',
        '손상된 원본은 저장 폴더에 .broken- 으로 남겨 두었습니다.',
      ].join('\n'),
    }));
  } else if (store.lostData) {
    withModal(() => dialog.showMessageBox({
      type: 'error',
      buttons: ['확인'],
      message: '메모 파일이 손상됐고 되살릴 백업도 없습니다.',
      detail: [
        '빈 상태로 시작합니다.',
        '손상된 원본은 저장 폴더에 .broken- 으로 남겨 두었으니 지우지 마세요.',
        '이미지와 첨부파일은 하나도 지우지 않고 그대로 두었습니다.',
      ].join('\n'),
    }));
  }
}

/*
 * 첨부파일 폴더를 지켜본다.
 * 탐색기에서 파일을 지우면 메모에 남은 칩은 열리지 않는 껍데기가 된다.
 * 폴더가 바뀌면 창들에게 알려 각자 자기 메모를 정리하게 한다.
 */
let fileWatcher = null;
let fileWatchTimer = null;

function startFileWatch() {
  if (fileWatcher) { try { fileWatcher.close(); } catch { /* 이미 닫힘 */ } }
  fileWatcher = null;
  try {
    fileWatcher = fs.watch(store.fileDir, () => {
      // 파일 하나를 지워도 이벤트가 여러 번 온다. 잠깐 모았다가 한 번만 알린다.
      clearTimeout(fileWatchTimer);
      fileWatchTimer = setTimeout(() => {
        for (const pane of panes.values()) {
          if (!pane.win.isDestroyed()) pane.win.webContents.send('files:changed');
        }
      }, 250);
    });
  } catch (e) {
    console.error('첨부 폴더를 지켜볼 수 없습니다:', e.message);
  }
}

function broadcastSettings() {
  for (const pane of panes.values()) {
    if (!pane.win.isDestroyed()) pane.win.webContents.send('settings:changed', store.get().settings);
  }
}

function broadcastDocks() {
  const list = store.get().docks.map((d) => ({ id: d.id, edge: d.edge, displayId: d.displayId, label: dockLabel(d) }));
  for (const pane of panes.values()) {
    if (!pane.win.isDestroyed()) pane.win.webContents.send('docks:changed', list);
  }
  refreshTrayMenu();
}

// ---------------------------------------------------------------- 백업

let backupTimer = null;

/** 실행 직후 한 번, 이후 설정한 주기마다 data.json 스냅샷을 남긴다. */
function startBackups() {
  clearInterval(backupTimer);
  const hours = Number(store.get().settings.backupHours) || 0;
  if (!hours) return;

  try { store.backup(); } catch (e) { console.error('백업 실패:', e.message); }
  backupTimer = setInterval(() => {
    try { store.backup(); } catch (e) { console.error('백업 실패:', e.message); }
  }, hours * 60 * 60 * 1000);
}

/** 저장 폴더를 통째로 옮긴다. 복사가 끝난 뒤에만 원본을 지운다. */
function moveDataDir(from, to) {
  const items = ['data.json', 'images', 'files', 'backups'];
  fs.mkdirSync(to, { recursive: true });

  for (const name of items) {
    const src = path.join(from, name);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(to, name), { recursive: true, force: true });
  }
  for (const name of items) {
    const src = path.join(from, name);
    try { fs.rmSync(src, { recursive: true, force: true }); } catch { /* 잠겨 있으면 남겨둔다 */ }
  }
}

// ---------------------------------------------------------------- 검색

function searchAll(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const out = [];
  for (const dock of store.get().docks) {
    for (const tab of dock.tabs) {
      const text = htmlToText(tab.html);
      const hay = text.toLowerCase();
      const inName = tab.name.toLowerCase().includes(q);
      const at = hay.indexOf(q);
      if (at < 0 && !inName) continue;

      // 찾은 자리 앞뒤로 잘라 미리보기를 만든다
      const start = Math.max(0, at - 24);
      const snippet = at < 0
        ? text.slice(0, 60)
        : (start > 0 ? '…' : '') + text.slice(start, at + q.length + 40);

      out.push({
        dockId: dock.id,
        dockLabel: dockLabel(dock),
        tabId: tab.id,
        tabName: tab.name,
        color: tab.color,
        snippet: snippet || '(내용 없음)',
        matchInName: inName,
        updatedAt: tab.updatedAt || 0,
      });
    }
  }
  return out.sort((a, b) => (b.matchInName - a.matchInName) || (b.updatedAt - a.updatedAt)).slice(0, 60);
}

// ---------------------------------------------------------------- 단축키

const SHORTCUT_ACTIONS = {
  toggle: () => {
    if (hiddenAll) setHiddenAll(false);   // 숨겨둔 상태면 먼저 다시 보이게
    toggleDock(lastActiveDockId);
  },
  newNote: () => {
    const id = lastActiveDockId;
    slideTo(id, true, { focus: true });
    const pane = panes.get(id);
    if (pane) pane.win.webContents.send('ui:new-tab');
  },
  hideAll: () => setHiddenAll(!hiddenAll),
  nextTab: () => {
    const id = lastActiveDockId;
    slideTo(id, true);
    const pane = panes.get(id);
    if (pane) pane.win.webContents.send('ui:next-tab');
  },
};

/** 설정된 단축키를 다시 등록하고, 다른 프로그램이 선점해 실패한 항목의 이름을 돌려준다. */
function applyShortcuts() {
  globalShortcut.unregisterAll();
  const failed = [];
  if (!store.get().settings.shortcutsEnabled) return failed;

  for (const [name, accel] of Object.entries(store.get().settings.shortcuts || {})) {
    if (!accel || !SHORTCUT_ACTIONS[name]) continue;
    let ok = false;
    try { ok = globalShortcut.register(accel, SHORTCUT_ACTIONS[name]); } catch { ok = false; }
    if (!ok) failed.push(name);
  }
  return failed;
}

// ---------------------------------------------------------------- IPC

function paneOf(event) {
  for (const pane of panes.values()) {
    if (!pane.win.isDestroyed() && pane.win.webContents.id === event.sender.id) return pane;
  }
  return null;
}

/*
 * 첨부파일을 userData/files 아래로 복사한다.
 * 폴더를 탐색기로 열었을 때 알아볼 수 있도록 '원래 이름 그대로' 저장하고,
 * 같은 이름이 이미 있으면 '이름 (2).확장자' 로 비켜 간다.
 * 이름을 다듬는 규칙은 share.js 의 uniqueStoredName 에 있다.
 */
function storeFile(buffer, originalName) {
  const token = uniqueStoredName(store.fileDir, originalName);
  fs.writeFileSync(path.join(store.fileDir, token), buffer);
  return { token, name: path.basename(String(originalName || '')), size: buffer.length };
}

/**
 * 메모에 적힌 토큰을 실제 경로로 바꾼다. 폴더를 벗어나는 값은 거절한다.
 * 메모 HTML 에는 퍼센트 인코딩된 이름이 들어 있으므로 먼저 되돌린다.
 */
function resolveStoredFile(token) {
  let raw = String(token || '');
  try { raw = decodeURIComponent(raw); } catch { /* 인코딩이 깨졌으면 원문 그대로 본다 */ }
  const name = path.basename(raw);
  const file = path.join(store.fileDir, name);
  if (!file.startsWith(store.fileDir) || !fs.existsSync(file)) return null;
  return file;
}

function saveImageBuffer(buffer, ext) {
  const safeExt = IMAGE_EXTS.includes(String(ext).toLowerCase()) ? ext.toLowerCase() : 'png';
  const name = `${crypto.randomUUID()}.${safeExt}`;
  fs.writeFileSync(path.join(store.imageDir, name), buffer);
  return `sidememo-img://img/${name}`;
}

function registerIpc() {
  ipcMain.handle('state:get', (e) => {
    const pane = paneOf(e);
    const dock = pane ? store.getDock(pane.dockId) : store.get().docks[0];
    return {
      settings: store.get().settings,
      dock,
      docks: store.get().docks.map((d) => ({ id: d.id, edge: d.edge, displayId: d.displayId, label: dockLabel(d) })),
    };
  });

  ipcMain.handle('displays:list', () => displayList());

  ipcMain.handle('state:saveTabs', (e, payload) => {
    const pane = paneOf(e);
    const dock = pane && store.getDock(pane.dockId);
    if (!dock) return false;
    // 빈 목록이 저장되면 그 가장자리의 메모가 통째로 사라진다.
    // 정상적인 경로로는 올 수 없는 값이므로 저장하지 않고 거절한다.
    if (!Array.isArray(payload && payload.tabs) || !payload.tabs.length) return false;
    dock.tabs = payload.tabs;
    dock.activeTabId = payload.activeTabId;
    store.save();
    return true;
  });

  ipcMain.handle('state:saveSettings', (_e, settings) => {
    const prev = store.get().settings;
    store.get().settings = { ...prev, ...settings };
    store.save();

    if (settings.shortcutsEnabled !== undefined && settings.shortcutsEnabled !== prev.shortcutsEnabled) {
      applyShortcuts();
    }
    if (settings.launchOnStartup !== undefined && settings.launchOnStartup !== prev.launchOnStartup) {
      app.setLoginItemSettings({ openAtLogin: settings.launchOnStartup });
    }
    if (settings.backupHours !== undefined && settings.backupHours !== prev.backupHours) {
      startBackups();
    }
    if (updater && (settings.updateMode !== prev.updateMode || settings.updateTime !== prev.updateTime)) {
      updater.replan();
    }
    repositionAll();
    refreshTrayMenu();
    broadcastSettings();
    return store.get().settings;
  });

  ipcMain.handle('shortcuts:set', (_e, next) => {
    const prev = { ...store.get().settings.shortcuts };
    store.get().settings.shortcuts = { ...prev, ...next };

    let failed = applyShortcuts();
    if (failed.length) {
      // 등록에 실패한 항목만 원래 조합으로 되돌린다. 못 쓰는 단축키를 저장해두지 않기 위해.
      for (const name of failed) store.get().settings.shortcuts[name] = prev[name];
      applyShortcuts();
    }
    store.save();
    return { shortcuts: store.get().settings.shortcuts, failed };
  });

  // ── 휴지통 ───────────────────────────────────────────

  ipcMain.handle('trash:list', () => store.get().trash.map((t) => ({
    id: t.id, name: t.name, color: t.color, dockLabel: t.dockLabel,
    deletedAt: t.deletedAt, preview: htmlToText(t.html).slice(0, 80),
  })));

  ipcMain.handle('trash:add', (e, tab) => {
    const pane = paneOf(e);
    const dock = pane && store.getDock(pane.dockId);
    if (!dock) return false;
    store.trashTab(dock.id, dockLabel(dock), tab);
    return true;
  });

  ipcMain.handle('trash:restore', (e, tabId) => {
    const res = store.restoreTab(tabId);
    if (!res) return { ok: false };

    const from = paneOf(e);
    const pane = panes.get(res.dockId);
    if (pane && !pane.win.isDestroyed()) {
      pane.win.webContents.send('state:reload', { selectTabId: res.tabId });
      // 요청한 창과 같을 때만 펼친다. 다른 창을 띄우면 지금 보던 설정 화면이 닫혀버린다.
      if (!from || from.dockId === res.dockId) slideTo(res.dockId, true, { focus: true });
    }
    const dock = store.getDock(res.dockId);
    return { ok: true, ...res, sameDock: !from || from.dockId === res.dockId, label: dock ? dockLabel(dock) : '' };
  });

  ipcMain.handle('trash:delete', (_e, tabId) => {
    const ok = store.deleteFromTrash(tabId);
    store.pruneImages();
    return ok;
  });

  ipcMain.handle('trash:empty', () => {
    store.emptyTrash();
    store.pruneImages();
    return true;
  });

  // ── 백업 / 저장 위치 ──────────────────────────────────

  ipcMain.handle('backup:now', () => {
    try { return { ok: true, file: path.basename(store.backup()) }; }
    catch (err) { return { ok: false, reason: err.message }; }
  });

  ipcMain.handle('backup:list', () => store.listBackups());
  ipcMain.handle('backup:openFolder', () => shell.openPath(store.backupDir));

  ipcMain.handle('data:location', () => ({
    dir: store.dir,
    defaultDir: defaultDataDir(),
    isDefault: store.dir === defaultDataDir(),
  }));

  ipcMain.handle('data:openFolder', () => shell.openPath(store.dir));

  ipcMain.handle('data:setLocation', async (e, useDefault) => {
    const pane = paneOf(e);
    let target = defaultDataDir();

    if (!useDefault) {
      const res = await withModal(() => dialog.showOpenDialog(pane ? pane.win : undefined, {
        title: '메모를 저장할 폴더 선택',
        properties: ['openDirectory', 'createDirectory'],
      }));
      if (res.canceled) return { ok: false };
      target = res.filePaths[0];
    }
    if (target === store.dir) return { ok: true, dir: target };

    // 이미 데이터가 있는 폴더라면 덮어쓸지 물어본다.
    if (fs.existsSync(path.join(target, 'data.json'))) {
      const { response } = await withModal(() => dialog.showMessageBox(pane ? pane.win : undefined, {
        type: 'question',
        buttons: ['취소', '그 폴더의 메모 쓰기', '지금 메모로 덮어쓰기'],
        defaultId: 1,
        cancelId: 0,
        message: '그 폴더에 이미 메모 데이터가 있습니다.',
        detail: '다른 PC에서 쓰던 폴더라면 "그 폴더의 메모 쓰기"를 고르세요.',
      }));
      if (response === 0) return { ok: false };
      if (response === 1) {
        writeDataDir(target);
        store = new Store(target);
        startFileWatch();
        reloadAllWindows();
        return { ok: true, dir: target };
      }
    }

    try {
      store.save();
      moveDataDir(store.dir, target);
      writeDataDir(target);
      store = new Store(target);
      startBackups();
      startFileWatch();
      reloadAllWindows();
      return { ok: true, dir: target };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  // ── 검색 ─────────────────────────────────────────────

  ipcMain.handle('search:all', (_e, query) => searchAll(query));

  ipcMain.handle('search:open', (_e, { dockId, tabId }) => {
    const pane = panes.get(dockId);
    if (!pane || pane.win.isDestroyed()) return false;
    slideTo(dockId, true, { focus: true });
    pane.win.webContents.send('ui:select-tab', tabId);
    return true;
  });

  // ── 가장자리(dock) 관리 ────────────────────────────────

  ipcMain.handle('docks:update', (e, patch) => {
    const pane = paneOf(e);
    const dock = pane && store.getDock(pane.dockId);
    if (!dock) return { ok: false };

    // 탭 세로 위치만 바꾸는 경우는 자리 충돌과 무관하다.
    if (patch.tabsOffset !== undefined) {
      dock.tabsOffset = Math.max(0, Math.min(1, Number(patch.tabsOffset) || 0));
      store.save();
      return { ok: true, dock: { id: dock.id, edge: dock.edge, displayId: dock.displayId, tabsOffset: dock.tabsOffset } };
    }

    const edge = patch.edge ?? dock.edge;
    const displayId = patch.displayId !== undefined ? patch.displayId : dock.displayId;
    if (isSpotTaken(displayId, edge, dock.id)) {
      return { ok: false, reason: '그 자리에는 이미 다른 메모가 붙어 있습니다.' };
    }
    dock.edge = edge;
    dock.displayId = displayId;
    // 고른 모니터를 재부팅 뒤에도 다시 찾을 수 있게 화면 좌표를 같이 남긴다
    const picked = displayId == null ? null : allDisplays().find((d) => d.id === displayId);
    if (picked) dock.displayHint = { ...hintOf(picked), count: allDisplays().length };
    else delete dock.displayHint;
    if (picked) sessionIds.set(dock.id, picked.id);
    else sessionIds.delete(dock.id);
    store.save();
    reposition(dock.id);
    broadcastDocks();
    return { ok: true, dock: { id: dock.id, edge: dock.edge, displayId: dock.displayId, tabsOffset: dock.tabsOffset } };
  });

  ipcMain.handle('docks:add', () => {
    // 비어 있는 (모니터, 가장자리) 자리를 앞에서부터 찾는다.
    for (const d of displayList()) {
      for (const edge of ['right', 'left']) {
        if (!isSpotTaken(d.id, edge)) {
          const dock = store.addDock(edge, d.isPrimary ? null : d.id);
          const disp = !d.isPrimary && allDisplays().find((x) => x.id === d.id);
          if (disp) {
            dock.displayHint = { ...hintOf(disp), count: allDisplays().length };
            sessionIds.set(dock.id, disp.id);
            store.save();
          }
          createPane(dock);
          broadcastDocks();
          return { ok: true, id: dock.id };
        }
      }
    }
    return { ok: false, reason: '더 붙일 자리가 없습니다.' };
  });

  ipcMain.handle('docks:remove', (_e, id) => {
    if (!store.removeDock(id)) return { ok: false, reason: '마지막 하나는 지울 수 없습니다.' };
    destroyPane(id);
    store.pruneImages();
    broadcastDocks();
    return { ok: true };
  });

  // ── 패널 여닫기 / 폭 ──────────────────────────────────

  /*
   * 테스트 전용. 임시 프로필(--user-data-dir)로 띄운 경우에만 등록된다.
   * 모니터를 실제로 끌 수는 없으니 모니터 목록을 바꿔 끼워 '꺼짐·켜짐'을 흉내 낸다.
   */
  if (customProfile) {
    // silent: 알림 없이 목록만 바꾼다 (모니터 알림을 놓친 상황 — 1.5초 감시가 따라잡아야 한다)
    ipcMain.handle('test:fakeDisplays', (_e, fake, silent) => {
      fakeDisplays = fake || null;
      if (!silent) handleDisplaysChanged();
      return true;
    });
    ipcMain.handle('test:paneInfo', () => [...panes].map(([id, p]) => ({
      id, visible: p.win.isVisible(), waiting: !!p.waiting, peek: !!p.peek,
      expanded: !!p.expanded, bounds: p.win.getBounds(),
      label: store.getDock(id) ? dockLabel(store.getDock(id)) : '',
    })));
    ipcMain.handle('test:toggleDock', (_e, id) => { toggleDock(id); return true; });
    ipcMain.handle('test:settleMs', (_e, ms) => { SETTLE_MS = Number(ms) || 0; return SETTLE_MS; });
    ipcMain.handle('test:forgetSession', () => { sessionIds.clear(); return true; });
    ipcMain.handle('test:flushAll', () => flushAll());
    ipcMain.handle('test:updateTick', () => { if (updater) updater.tick(); return updater ? updater.state() : null; });
    ipcMain.handle('test:forceBusy', (_e, v) => { forceBusy = v == null ? null : !!v; return forceBusy; });
    ipcMain.handle('test:collapse', (_e, id) => { slideTo(id, false); return true; });
    ipcMain.handle('test:setHiddenAll', (_e, v) => setHiddenAll(v));
  }

  ipcMain.handle('tabs:dragging', (e, value) => {
    const pane = paneOf(e);
    if (!pane) return;
    pane.tabDragging = !!value;
    if (pane.tabDragging) setInteractive(pane, true);   // 띠 밖으로 나가도 놓는 순간까지 받는다
    else {
      showDropTarget(null);
      if (!pane.expanded) setInteractive(pane, pane.overStrip);
    }
  });

  /*
   * 커서가 다른 가장자리의 띠 위에 있으면 그쪽으로 옮긴다.
   * 저장소에서 먼저 옮겨 두고(도중에 꺼져도 잃지 않게), 받는 창에는 메모를 넘겨준다.
   * 받는 창이 자기 목록에 직접 넣어 저장해야, 그 창이 늦게 보낸 저장에 덮이지 않는다.
   */
  ipcMain.handle('tabs:moveToDock', (e, { tabId, point }) => {
    const from = paneOf(e);
    if (!from) return { moved: false };
    // 놓은 지점은 포인터 이벤트가 알려준 화면 좌표를 쓴다. 없으면 지금 커서 위치.
    const ok = point && Number.isFinite(point.x) && Number.isFinite(point.y);
    const p = ok ? { x: Math.round(point.x), y: Math.round(point.y) } : screen.getCursorScreenPoint();
    const target = dropTargetAt(p, from.dockId);
    showDropTarget(null);
    if (!target) return { moved: false };

    // 놓은 높이를 기억한다 (자유 배치를 끈 경우엔 맨 아래로)
    let top = null;
    if (store.get().settings.freeTabLayout !== false) {
      const b = target.win.getBounds();
      const stripTop = b.y + 14;                 // #tabstrip 의 위쪽 여백
      const stripH = Math.max(1, b.height - 28 - 60);
      top = Math.max(0, Math.min(1, (p.y - stripTop - 30) / stripH));
    }

    const res = store.moveTab(from.dockId, tabId, target.dockId, top);
    if (!res.ok) return { moved: false, reason: res.reason };

    target.win.webContents.send('tabs:receive', { tab: res.tab });
    slideTo(target.dockId, true);
    const dock = store.getDock(target.dockId);
    return { moved: true, label: dock ? dockLabel(dock) : '' };
  });

  ipcMain.handle('panel:setInteractive', (e, value) => {
    const pane = paneOf(e);
    if (pane && !pane.expanded) setInteractive(pane, !!value);
  });

  ipcMain.handle('panel:set', (e, isExpanded, opts) => {
    const pane = paneOf(e);
    if (pane) slideTo(pane.dockId, isExpanded, opts || {});
  });

  ipcMain.handle('panel:focus', (e) => {
    const pane = paneOf(e);
    if (pane && !pane.win.isDestroyed()) pane.win.focus();
  });

  ipcMain.handle('panel:hideAll', () => setHiddenAll(true));

  ipcMain.handle('panel:setPinned', (e, value) => {
    const pane = paneOf(e);
    return pane ? setPinned(pane.dockId, value) : false;
  });

  // 지금 화면에 쓸 폭만 바꾼다. 저장은 렌더러가 (전체 기본값이냐 이 메모냐에 따라) 따로 한다.
  ipcMain.handle('panel:useWidth', (e, width) => {
    const pane = paneOf(e);
    if (!pane) return;
    pane.activeWidth = width == null ? null : Math.max(MIN_PANEL_W, Math.min(MAX_PANEL_W, Math.round(width)));
    reposition(pane.dockId);
  });

  /*
   * 모서리를 잡고 끄는 동안에는 창을 최대 폭으로 넓혀두고 패널만 CSS 로 줄인다.
   * 창을 매 프레임 리사이즈하면 폭을 줄일 때 커서가 창 밖으로 빠져나가 드래그가 끊긴다.
   */
  ipcMain.handle('panel:beginResize', (e) => {
    const pane = paneOf(e);
    if (!pane) return;
    pane.resizing = true;
    pane.win.setBounds(boundsFor(store.getDock(pane.dockId), MAX_PANEL_W));
  });

  ipcMain.handle('panel:endResize', (e, width) => {
    const pane = paneOf(e);
    if (!pane) return MIN_PANEL_W;
    pane.resizing = false;
    pane.activeWidth = Math.max(MIN_PANEL_W, Math.min(MAX_PANEL_W, Math.round(width)));
    reposition(pane.dockId);
    return pane.activeWidth;
  });

  // ── 이미지 / 기타 ────────────────────────────────────

  ipcMain.handle('images:pick', async (e, remaining) => {
    const pane = paneOf(e);
    const res = await withModal(() => dialog.showOpenDialog(pane ? pane.win : undefined, {
      title: '이미지 선택',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '이미지', extensions: IMAGE_EXTS }],
    }));
    if (res.canceled) return [];
    return res.filePaths.slice(0, Math.max(0, remaining)).map((p) => {
      const ext = path.extname(p).slice(1);
      return saveImageBuffer(fs.readFileSync(p), ext);
    });
  });

  ipcMain.handle('images:save', (_e, { buffer, ext }) => saveImageBuffer(Buffer.from(buffer), ext));
  ipcMain.handle('images:prune', () => { store.pruneImages(); return true; });

  // ── 첨부파일 ─────────────────────────────────────────

  ipcMain.handle('files:pick', async (e) => {
    const pane = paneOf(e);
    const res = await withModal(() => dialog.showOpenDialog(pane ? pane.win : undefined, {
      title: '메모에 넣을 파일 선택',
      properties: ['openFile', 'multiSelections'],
    }));
    if (res.canceled) return [];
    return res.filePaths.map((p) => storeFile(fs.readFileSync(p), path.basename(p)));
  });

  ipcMain.handle('files:save', (_e, { buffer, name }) => storeFile(Buffer.from(buffer), name));

  ipcMain.handle('files:open', async (e, token) => {
    const file = resolveStoredFile(token);
    if (!file) return { ok: false, reason: '파일을 찾을 수 없습니다.' };

    // 실행 파일은 클릭 한 번에 실행되지 않도록 한 번 더 묻는다.
    if (EXECUTABLE_EXTS.includes(path.extname(file).toLowerCase())) {
      const pane = paneOf(e);
      const { response } = await withModal(() => dialog.showMessageBox(pane ? pane.win : undefined, {
        type: 'warning',
        buttons: ['취소', '실행'],
        defaultId: 0,
        cancelId: 0,
        message: '실행 파일을 여시겠습니까?',
        detail: `${path.basename(file)}\n\n이 파일은 실행되면 컴퓨터를 변경할 수 있습니다.`,
      }));
      if (response !== 1) return { ok: false };
    }

    const err = await shell.openPath(file);
    return err ? { ok: false, reason: err } : { ok: true };
  });

  ipcMain.handle('files:reveal', (_e, token) => {
    const file = resolveStoredFile(token);
    if (file) shell.showItemInFolder(file);
  });

  ipcMain.handle('files:delete', (_e, token) => {
    const file = resolveStoredFile(token);
    if (!file) return { ok: true };          // 이미 없으면 지운 것과 같다
    try {
      fs.unlinkSync(file);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  /** 넘어온 토큰 중 실제 파일이 없어진 것만 돌려준다. */
  ipcMain.handle('files:missing', (_e, tokens) => (
    (Array.isArray(tokens) ? tokens : []).filter((t) => !resolveStoredFile(t))
  ));

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // ── 메모 내보내기 / 가져오기 ───────────────────────────

  ipcMain.handle('memo:export', async (e, { scope }) => {
    const pane = paneOf(e);
    const dock = pane && store.getDock(pane.dockId);
    if (!dock) return { ok: false };

    const tabs = scope === 'all' ? dock.tabs : [dock.tabs.find((t) => t.id === dock.activeTabId) || dock.tabs[0]];
    const base = scope === 'all' ? `사이드메모 ${tabs.length}개` : safeFileName(tabs[0].name);

    const res = await withModal(() => dialog.showSaveDialog(pane.win, {
      title: '메모 내보내기',
      defaultPath: `${base}.smemo`,
      filters: [
        { name: '사이드 메모 (앱에서 그대로 열림)', extensions: ['smemo'] },
        { name: '웹페이지 (아무 데서나 열림)', extensions: ['html'] },
        { name: '텍스트', extensions: ['txt'] },
      ],
    }));
    if (res.canceled) return { ok: false };

    const ext = path.extname(res.filePath).toLowerCase();
    try {
      if (ext === '.txt') {
        fs.writeFileSync(res.filePath, share.toPlainText(tabs), 'utf8');
      } else if (ext === '.html') {
        fs.writeFileSync(res.filePath, share.toStandaloneHtml(tabs, store.get().settings), 'utf8');
      } else {
        fs.writeFileSync(res.filePath, JSON.stringify(share.toBundle(tabs), null, 2), 'utf8');
      }
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    return { ok: true, file: path.basename(res.filePath), count: tabs.length, dir: path.dirname(res.filePath) };
  });

  ipcMain.handle('memo:import', async (e) => {
    const pane = paneOf(e);
    const res = await withModal(() => dialog.showOpenDialog(pane ? pane.win : undefined, {
      title: '메모 가져오기',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '사이드 메모', extensions: ['smemo'] },
        { name: '텍스트', extensions: ['txt', 'md'] },
      ],
    }));
    if (res.canceled) return { ok: false };

    const memos = [];
    for (const file of res.filePaths) {
      try {
        const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
        if (path.extname(file).toLowerCase() === '.smemo') {
          memos.push(...share.fromBundle(JSON.parse(raw)));
        } else {
          memos.push(share.fromPlainText(raw, path.basename(file, path.extname(file))));
        }
      } catch (err) {
        return { ok: false, reason: `${path.basename(file)}: ${err.message}` };
      }
    }
    return { ok: true, memos };
  });

  ipcMain.handle('app:quit', () => quitApp());
  ipcMain.handle('app:flushed', (_e, id) => { const done = flushWaiters.get(id); if (done) done(); });

  ipcMain.handle('update:state', () => (updater ? updater.state() : { status: 'off', current: app.getVersion() }));
  ipcMain.handle('update:check', () => (updater ? updater.check({ manual: true }) : false));
  ipcMain.handle('update:applyNow', () => (updater ? updater.applyNow() : false));
  ipcMain.handle('update:applyAt', (_e, ms) => (updater ? updater.applyAt(ms) : false));
}

// ---------------------------------------------------------------- 부팅

// 두 번 실행하면 기존 인스턴스를 펼치고 새 인스턴스는 종료한다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (hiddenAll) setHiddenAll(false);   // 숨겨둔 상태면 먼저 다시 보이게 한다
    slideTo(lastActiveDockId, true);
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.sidememo.app');   // 윈도우 알림에 필요 (package.json 의 appId 와 같게)
    migrateOldProfile();
    store = new Store(readDataDir());
    share = createShare({ imageDir: store.imageDir, fileDir: store.fileDir, uuid: () => crypto.randomUUID() });
    store.purgeTrash();
    startBackups();
    reportRecovery();

    protocol.handle('sidememo-img', (req) => {
      const name = path.basename(decodeURIComponent(new URL(req.url).pathname));
      const file = path.join(store.imageDir, name);
      if (!file.startsWith(store.imageDir)) return new Response('', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });

    // 기본 메뉴를 없앤다. Ctrl+R / F5 가 새로고침으로 먹히면 편집 중인 메모가 날아간다.
    if (!DEV) Menu.setApplicationMenu(null);

    refreshDockDisplays();   // 재부팅으로 모니터 id 가 바뀌었으면 여기서 바로잡는다
    for (const dock of store.get().docks) createPane(dock);
    buildTray();
    registerIpc();
    startCursorWatch();
    startPlacementWatch();
    handleDisplaysChanged();   // 배치가 가라앉는 대로(약 3초) 창을 띄운다
    startUpdater();
    startFileWatch();

    const failed = applyShortcuts();
    if (failed.length) console.warn('등록하지 못한 단축키:', failed.join(', '));
    if (DEV) console.log('[displays]', JSON.stringify(displayList()));

    const onDisplaysChanged = handleDisplaysChanged;
    screen.on('display-metrics-changed', onDisplaysChanged);
    screen.on('display-added', onDisplaysChanged);
    screen.on('display-removed', onDisplaysChanged);

    // 윈도우 시작과 함께 켜지면 모니터가 다 잡히기 전에 창을 띄울 수 있다.
    // '모니터 추가' 알림을 놓쳤더라도 제자리를 찾도록 조금 뒤에 한 번 더 맞춘다.
    setTimeout(onDisplaysChanged, 5000);

    // 개발용: 실행하자마자 패널(과 설정)을 펼쳐 화면을 확인한다.
    if (DEV && process.argv.includes('--open-settings')) {
      setTimeout(() => openSettings(lastActiveDockId), 1200);
    } else if (DEV && process.argv.includes('--open')) {
      setTimeout(() => slideTo(lastActiveDockId, true, { focus: true }), 1200);
    }
  });

  app.on('window-all-closed', () => { /* 트레이 앱이므로 종료하지 않는다 */ });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    if (fileWatcher) { try { fileWatcher.close(); } catch { /* 이미 닫힘 */ } }
    clearInterval(watchTimer);
    clearInterval(placementTimer);
    clearInterval(backupTimer);
    globalShortcut.unregisterAll();
  });
}
