'use strict';

const api = window.sideMemo;

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const editor = $('#editor');
const tabsEl = $('#tabs');
const tabNameEl = $('#tab-name');
const chipLabel = $('#chip-label');

// 닫히는 속도 설정에 맞춘 슬라이드 애니메이션 길이
const SLIDE_MS = { instant: '100ms', fast: '140ms', normal: '190ms' };
const MIN_PANEL_W = 260;
const MAX_PANEL_W = 900;
const TAB_COLORS = ['#C4B5FD', '#E9E7E0', '#FBCFE8', '#BBF7D0', '#BFDBFE', '#FDE68A'];
const BG_COLORS = ['#FBF3B0', '#FFFFFF', '#FFE4EC', '#DCFCE7', '#DBEAFE', '#EDE9FE', '#374151', '#1F2937'];
const TEXT_COLORS = ['#4C1D95', '#111827', '#7C3AED', '#B91C1C', '#047857', '#1D4ED8', '#F9FAFB', '#6B7280'];
const FONTS = [
  'Malgun Gothic', 'Pretendard', 'Nanum Gothic', 'Nanum Myeongjo',
  'Gulim', 'Batang', 'Segoe UI', 'Arial', 'Georgia', 'Consolas',
];

let state = null;
let expanded = false;
let pinned = false;
let overTabs = false;          // 접힌 상태에서 커서가 탭 띠 위에 있는지
let overStrip = false;         // 메인이 알려주는 '가장자리에 커서가 닿음'
let draggingTab = false;       // 탭을 끌어 옮기는 중
let tabClickTimer = null;      // 더블클릭이 오면 취소할 '접기' 예약
let primaryDisplayId = null;
let displayCount = 1;
let selectedImg = null;
let saveTimer = null;

// ─────────────────────────────────────────── 상태 저장

/* 이 창은 가장자리(dock) 하나를 담당한다. 메모 목록은 그 dock 의 것이다. */
const tabsOf = () => state.dock.tabs;

function activeTab() {
  return tabsOf().find((t) => t.id === state.dock.activeTabId) || tabsOf()[0];
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tab = activeTab();
  if (tab) {
    tab.html = editor.innerHTML;
    tab.updatedAt = Date.now();
  }
  return api.saveTabs({ tabs: state.dock.tabs, activeTabId: state.dock.activeTabId });
}

function saveSettings(patch) {
  Object.assign(state.settings, patch);
  applySettings();
  api.saveSettings(state.settings);
}

// ─────────────────────────────────────────── 렌더링

/* 크기는 메모별 값이 있으면 그것을, 없으면 전체 기본값을 쓴다. */
function effFontSize() {
  const t = activeTab();
  return t && t.fontSize != null ? t.fontSize : state.settings.fontSize;
}

function effPanelWidth() {
  const t = activeTab();
  return t && t.panelWidth != null ? t.panelWidth : state.settings.panelWidth;
}

function applySettings() {
  const s = state.settings;
  const root = document.documentElement.style;
  root.setProperty('--bg', s.bgColor);
  root.setProperty('--fg', s.textColor);
  root.setProperty('--font', `'${s.fontFamily}', sans-serif`);
  root.setProperty('--size', `${effFontSize()}px`);
  root.setProperty('--panel-alpha', String(s.opacity));
  root.setProperty('--slide-ms', SLIDE_MS[s.closeSpeed] || SLIDE_MS.fast);
  updateTabVisibility(false);
  app.classList.toggle('edge-left', state.dock.edge === 'left');
  app.classList.toggle('edge-right', state.dock.edge !== 'left');
}

function renderTabs() {
  tabsEl.textContent = '';
  for (const tab of state.dock.tabs) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (tab.id === state.dock.activeTabId ? ' active' : '');
    btn.dataset.id = tab.id;
    btn.textContent = tab.name;
    btn.style.background = tab.color;
    btn.title = tab.name;
    btn.addEventListener('click', (e) => {
      if (e.detail >= 2) return;          // 더블클릭이면 dblclick 쪽에서 고정을 처리한다
      // 접기는 잠깐 미룬다. 곧바로 두 번째 클릭이 오면(=더블클릭) 취소해야
      // 창이 닫히면서 두 번째 클릭을 놓치는 일이 없다.
      clearTimeout(tabClickTimer);
      if (tab.id === state.dock.activeTabId && expanded) {
        if (pinned) return;               // 고정 중에는 한 번 클릭으로 닫지 않는다
        tabClickTimer = setTimeout(() => setPanel(false), 220);
      } else {
        selectTab(tab.id);
        setPanel(true);
      }
    });
    btn.addEventListener('dblclick', (e) => {
      e.preventDefault();
      clearTimeout(tabClickTimer);        // 미뤄둔 접기 취소
      selectTab(tab.id);
      setPanel(true);
      togglePin();
    });
    btn.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (state.dock.tabs.length <= 1) return;
      const ok = await askConfirm(
        `'${tab.name}' 메모를 휴지통으로 보낼까요?\n설정 → 휴지통에서 되돌릴 수 있습니다.`,
        { yes: '휴지통으로' });
      if (ok) removeTab(tab.id);
    });
    tabsEl.appendChild(btn);
  }
  layoutTabs();
}

function loadActiveIntoEditor() {
  const tab = activeTab();
  editor.innerHTML = tab.html || '';
  tabNameEl.value = tab.name;
  chipLabel.textContent = tab.name;
  syncChipColor();
  syncFileChips();          // 밖에서 지워진 첨부가 있으면 걷어낸다
  editor.scrollTop = 0;
  deselectImage();

  // 메모마다 크기가 다를 수 있으므로 탭을 바꿀 때마다 다시 적용한다.
  applySettings();
  api.useWidth(effPanelWidth());
  if (state) syncSettingsUI();
}

function selectTab(id) {
  if (id === state.dock.activeTabId) return;
  flushSave();                    // 떠나기 전에 현재 탭 내용 확정
  state.dock.activeTabId = id;
  loadActiveIntoEditor();
  renderTabs();
  api.saveTabs({ tabs: state.dock.tabs, activeTabId: state.dock.activeTabId });
}

function addTab() {
  flushSave();
  const id = `tab-${Date.now()}`;
  state.dock.tabs.push({
    id,
    name: '새 메모',
    color: TAB_COLORS[state.dock.tabs.length % TAB_COLORS.length],
    html: '',
    panelWidth: null,
    fontSize: null,
    top: null,
    updatedAt: Date.now(),
  });
  state.dock.activeTabId = id;
  loadActiveIntoEditor();
  renderTabs();
  api.saveTabs({ tabs: state.dock.tabs, activeTabId: id });
  tabNameEl.focus();
  tabNameEl.select();
}

async function removeTab(id) {
  const idx = state.dock.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  // 한 장도 남지 않으면 편집할 대상이 사라진다. 조용히 무시하지 말고 이유를 알린다.
  if (state.dock.tabs.length <= 1) {
    toast('마지막 메모는 지울 수 없습니다');
    return;
  }

  // 지우기 전에 화면의 최신 내용을 확정해서 휴지통에 넣는다.
  if (id === state.dock.activeTabId) flushSave();
  await api.trashAdd(state.dock.tabs[idx]);

  state.dock.tabs.splice(idx, 1);
  if (state.dock.activeTabId === id) {
    state.dock.activeTabId = state.dock.tabs[Math.min(idx, state.dock.tabs.length - 1)].id;
    loadActiveIntoEditor();
  }
  renderTabs();
  api.saveTabs({ tabs: state.dock.tabs, activeTabId: state.dock.activeTabId });
  api.pruneImages();
}

// ─────────────────────────────────────────── 탭 위치

/*
 * 탭 배치에는 두 가지 방식이 있다 (설정의 '탭 자유 배치').
 *   켬  → 탭을 원하는 높이에 하나씩 둘 수 있다. tab.top(0~1)에 위치를 기억한다.
 *   끔  → 항상 위에서부터 차곡차곡. 끌면 순서만 바뀐다.
 * 어느 쪽이든 끄는 동안 결과가 바로 보이도록 옆 탭들이 실시간으로 밀린다.
 */
const TAB_GAP = 6;
const SNAP_PX = 12;

const freeLayout = () => state.settings.freeTabLayout !== false;
const stripHeight = () => $('#tabstrip').clientHeight;
const tabHeights = () => [...tabsEl.children].map((el) => el.offsetHeight);

/** y 부터 아래로 내려가며 h 만큼 들어갈 빈 자리를 찾는다. */
function firstFreeSlot(y, h, occupied, stripH) {
  let top = Math.max(0, y);
  for (let pass = 0; pass <= occupied.length; pass++) {
    const hit = occupied.find((o) => top < o.bottom && top + h > o.top);
    if (!hit) break;
    top = hit.bottom + TAB_GAP;
  }
  return Math.max(0, Math.min(stripH - h, top));
}

/** 지금 상태대로 모든 탭과 ＋ 버튼의 위치를 계산한다. */
function computeLayout() {
  const els = [...tabsEl.children];
  const stripH = stripHeight();
  const heights = tabHeights();
  const addH = $('#add-tab').offsetHeight;
  const tops = new Array(els.length).fill(0);
  const occupied = [];
  const isFixed = els.map((el, i) => freeLayout() && state.dock.tabs[i].top != null);

  // 1) 따로 옮겨둔 탭 먼저. 창이 줄어 겹치게 됐으면 아래로 밀어 떼어놓는다.
  const fixed = [];
  els.forEach((el, i) => {
    if (!isFixed[i]) return;
    fixed.push({ i, h: heights[i], top: state.dock.tabs[i].top * Math.max(0, stripH - heights[i]) });
  });
  fixed.sort((a, b) => a.top - b.top);

  let guard = 0;
  for (const f of fixed) {
    const top = Math.max(0, Math.min(stripH - f.h, Math.max(f.top, guard)));
    tops[f.i] = top;
    occupied.push({ top, bottom: top + f.h });
    guard = top + f.h + TAB_GAP;
  }

  // 2) 나머지는 위에서부터 차곡차곡. 위에서 찜한 구간은 건너뛴다.
  let autoH = 0;
  let autoCount = 0;
  els.forEach((el, i) => { if (!isFixed[i]) { autoH += heights[i] + TAB_GAP; autoCount++; } });
  autoH = Math.max(0, autoH - TAB_GAP);

  const room = Math.max(0, stripH - autoH - (autoCount ? TAB_GAP + addH : addH));
  let y = (Number(state.dock.tabsOffset) || 0) * room;

  els.forEach((el, i) => {
    if (isFixed[i]) return;
    const top = firstFreeSlot(y, heights[i], occupied, stripH);
    tops[i] = top;
    occupied.push({ top, bottom: top + heights[i] });
    y = top + heights[i] + TAB_GAP;
  });

  return { tops, addTop: firstFreeSlot(y, addH, occupied, stripH), heights, stripH };
}

function applyTops(tops, addTop) {
  [...tabsEl.children].forEach((el, i) => { el.style.top = Math.round(tops[i]) + 'px'; });
  $('#add-tab').style.top = Math.round(addTop) + 'px';
}

function layoutTabs() {
  if (!tabsEl.children.length) return;
  const { tops, addTop } = computeLayout();
  applyTops(tops, addTop);
}

window.addEventListener('resize', () => { if (state) layoutTabs(); });

function setTabsOffset(fraction, { save = false } = {}) {
  state.dock.tabsOffset = Math.max(0, Math.min(1, fraction));
  layoutTabs();

  const pct = Math.round(state.dock.tabsOffset * 100);
  $('#tabs-offset').value = pct;
  $('#tabs-offset-val').textContent = pct === 0 ? '맨 위' : pct === 100 ? '맨 아래' : pct + '%';

  if (save) api.updateDock({ tabsOffset: state.dock.tabsOffset });
}

/** 따로 옮겨둔 탭들을 모두 자동 배치로 되돌린다. */
function resetTabPositions() {
  for (const tab of state.dock.tabs) tab.top = null;
  layoutTabs();
  flushSave();
  toast('탭 위치를 초기화했습니다');
}

/** ＋ 버튼은 언제나 탭들 아래, 겹치지 않는 자리에 둔다. */
function addButtonTop(tops, heights, stripH) {
  const addH = $('#add-tab').offsetHeight;
  const occupied = tops.map((t, i) => ({ top: t, bottom: t + heights[i] }));
  const lowest = occupied.reduce((m, o) => Math.max(m, o.bottom), 0);
  return firstFreeSlot(lowest + TAB_GAP, addH, occupied, stripH);
}

// ─────────────────────────────────────────── 탭 끌기 (미리보기 포함)

/** 끌고 있는 탭을 이웃이나 화면 끝에 살짝 붙여준다. */
function snapTop(desired, height, selfIndex, baseTops, heights, stripH) {
  const targets = [0, stripH - height];
  baseTops.forEach((top, i) => {
    if (i === selfIndex) return;
    targets.push(top + heights[i] + TAB_GAP);
    targets.push(top - height - TAB_GAP);
  });

  let best = desired;
  let bestDist = SNAP_PX;
  for (const t of targets) {
    const d = Math.abs(desired - t);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return Math.max(0, Math.min(stripH - height, best));
}

/**
 * 자유 배치 미리보기.
 * 끌고 있는 탭을 dragTop 에 두고, 겹치는 이웃을 위/아래로 밀어낸 결과를 돌려준다.
 */
function pushPreview(dragIndex, dragTop, baseTops, heights, stripH) {
  const tops = baseTops.slice();
  tops[dragIndex] = dragTop;

  const dragCenter = dragTop + heights[dragIndex] / 2;
  const above = [];
  const below = [];
  baseTops.forEach((top, i) => {
    if (i === dragIndex) return;
    if (top + heights[i] / 2 < dragCenter) above.push(i);
    else below.push(i);
  });

  above.sort((a, b) => baseTops[b] - baseTops[a]);
  let limit = dragTop - TAB_GAP;
  for (const i of above) {
    const top = Math.max(0, Math.min(baseTops[i], limit - heights[i]));
    tops[i] = top;
    limit = top - TAB_GAP;
  }

  below.sort((a, b) => baseTops[a] - baseTops[b]);
  limit = dragTop + heights[dragIndex] + TAB_GAP;
  for (const i of below) {
    const top = Math.min(stripH - heights[i], Math.max(baseTops[i], limit));
    tops[i] = top;
    limit = top + heights[i] + TAB_GAP;
  }
  return tops;
}

/** 순서 바꾸기 미리보기. 끌고 있는 탭이 들어갈 자리를 비워두고 나머지를 쌓는다. */
function orderPreview(dragIndex, dragTop, heights, stripH) {
  const n = heights.length;
  const others = [];
  for (let i = 0; i < n; i++) if (i !== dragIndex) others.push(i);

  const addH = $('#add-tab').offsetHeight;
  let total = 0;
  for (let i = 0; i < n; i++) total += heights[i] + TAB_GAP;
  const room = Math.max(0, stripH - Math.max(0, total - TAB_GAP) - TAB_GAP - addH);
  const start = (Number(state.dock.tabsOffset) || 0) * room;

  // 끌고 있는 탭의 중심이 몇 번째 자리에 해당하는지 센다
  const dragCenter = dragTop + heights[dragIndex] / 2;
  let slot = 0;
  let probe = start;
  for (const i of others) {
    if (dragCenter > probe + heights[i] / 2) slot++;
    probe += heights[i] + TAB_GAP;
  }

  const tops = new Array(n).fill(0);
  let y = start;
  let slotTop = start;
  others.forEach((i, k) => {
    if (k === slot) { slotTop = y; y += heights[dragIndex] + TAB_GAP; }
    tops[i] = y;
    y += heights[i] + TAB_GAP;
  });
  if (slot >= others.length) { slotTop = y; y += heights[dragIndex] + TAB_GAP; }
  tops[dragIndex] = dragTop;

  return { tops, slot, slotTop, addTop: Math.max(0, Math.min(stripH - addH, y)) };
}

(() => {
  const THRESHOLD = 5;
  let ctx = null;

  function showDropSlot(top, height) {
    const slot = $('#drop-slot');
    slot.style.top = Math.round(top) + 'px';
    slot.style.height = Math.round(height) + 'px';
  }

  tabsEl.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.tab');
    if (!el) return;
    const els = [...tabsEl.children];
    ctx = {
      el,
      index: els.indexOf(el),
      startY: e.clientY,
      baseTops: els.map((x) => parseFloat(x.style.top) || 0),
      heights: tabHeights(),
      stripH: stripHeight(),
      preview: null,
    };
    ctx.startTop = ctx.baseTops[ctx.index];
  });

  tabsEl.addEventListener('pointermove', (e) => {
    if (!ctx) return;

    if (!draggingTab) {
      if (Math.abs(e.clientY - ctx.startY) < THRESHOLD) return;
      draggingTab = true;
      ctx.el.setPointerCapture(e.pointerId);
      ctx.el.classList.add('dragging');
      tabsEl.classList.add('reordering');
      $('#drop-slot').hidden = false;
    }

    const { index, heights, stripH, baseTops } = ctx;
    const h = heights[index];
    const wanted = Math.max(0, Math.min(stripH - h, ctx.startTop + (e.clientY - ctx.startY)));

    if (freeLayout()) {
      const top = snapTop(wanted, h, index, baseTops, heights, stripH);
      const tops = pushPreview(index, top, baseTops, heights, stripH);
      ctx.preview = { tops };
      applyTops(tops, addButtonTop(tops, heights, stripH));
      showDropSlot(top, h);
    } else {
      const p = orderPreview(index, wanted, heights, stripH);
      ctx.preview = p;
      applyTops(p.tops, p.addTop);
      showDropSlot(p.slotTop, h);
    }
  });

  function finish(e) {
    if (!ctx) return;
    const { el, index, preview, heights, stripH, baseTops } = ctx;
    const wasDragging = draggingTab;
    if (e && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    el.classList.remove('dragging');
    tabsEl.classList.remove('reordering');
    $('#drop-slot').hidden = true;
    ctx = null;

    if (!wasDragging || !preview) return;
    setTimeout(() => { draggingTab = false; }, 0);   // 뒤따라오는 click 을 흘려보낸다

    if (freeLayout()) {
      // 보이는 그대로 저장한다. 밀려난 이웃도 그 자리에 머문다.
      // 가만히 있던 탭은 건드리지 않아 자동 배치를 유지한다.
      preview.tops.forEach((top, i) => {
        if (i !== index && Math.abs(top - baseTops[i]) < 0.5) return;
        const room = Math.max(1, stripH - heights[i]);
        state.dock.tabs[i].top = Math.max(0, Math.min(1, top / room));
      });
      // 배열 순서를 화면에 보이는 순서와 맞춘다.
      // top 이 null 인(자동 배치) 탭은 값이 없으므로 실제로 그려진 위치를 기준으로 삼는다.
      const ordered = state.dock.tabs.map((tab, i) => ({ tab, y: preview.tops[i] }));
      ordered.sort((a, b) => a.y - b.y);
      state.dock.tabs = ordered.map((o) => o.tab);
    } else {
      // 순서만 바꾸고 위치는 자동 배치로 되돌린다
      const moved = state.dock.tabs[index];
      const rest = state.dock.tabs.filter((_, i) => i !== index);
      rest.splice(Math.max(0, Math.min(rest.length, preview.slot)), 0, moved);
      state.dock.tabs = rest;
      for (const tab of state.dock.tabs) tab.top = null;
    }

    flushSave();
    renderTabs();
  }

  tabsEl.addEventListener('pointerup', finish);
  tabsEl.addEventListener('pointercancel', finish);

  tabsEl.addEventListener('click', (e) => {
    if (draggingTab) { e.stopPropagation(); e.preventDefault(); }
  }, true);
})();

// ─────────────────────────────────────────── 패널 열고 닫기

function setPanel(next, opts) {
  if (next === expanded) return;
  expanded = next;                 // 왕복 IPC를 기다리지 않고 바로 반영해 연타를 막는다
  api.setPanel(next, opts);
}

api.onPanelState(({ expanded: e }) => {
  expanded = e;
  app.classList.toggle('collapsed', !e);
  updateTabVisibility(false);
  if (!e) {
    if (saveTimer) flushSave();   // 접히기 전에 쓰던 내용을 확정한다
    overTabs = false;
    closeAsk(false);
    closeAllPopovers();
    $('#settings').hidden = true;
  }
});

// 커서가 가장자리에 닿았는지는 메인이 알려준다 (창 밖에서는 mousemove 가 오지 않는다)
api.onEdgeHover((over) => { overStrip = over; updateTabVisibility(over); });

api.onPinChange((v) => {
  pinned = v;
  applyPinUI();
});

/** 고정 여부를 테두리·배지·버튼 세 곳에 한꺼번에 반영한다. */
function applyPinUI() {
  app.classList.toggle('pinned', pinned);
  $('#btn-pin').classList.toggle('on', pinned);
  $('#pin-badge').hidden = !pinned;
  $('#btn-pin').title = pinned ? '고정 해제 (탭을 더블클릭해도 됩니다)' : '고정 (탭을 더블클릭해도 됩니다)';
}

/*
 * 패널 안에서 뜨는 확인 창.
 * 네이티브 confirm() 은 창이 포커스를 잃게 만들고, 그러면 blur 로 메모지가 접히면서
 * 열어둔 설정 화면까지 닫혀버린다. 그래서 직접 그린다.
 */
let askResolve = null;

function askConfirm(message, { danger = false, yes = '확인' } = {}) {
  const box = $('#ask');
  $('#ask-msg').textContent = message;
  $('#ask-yes').textContent = yes;
  box.classList.toggle('danger', danger);
  box.hidden = false;
  // 창 포커스를 가져와야 '마우스가 벗어나면 접기' 감시가 멈춘다
  api.focusPanel();
  $('#ask-yes').focus();
  return new Promise((resolve) => { askResolve = resolve; });
}

function closeAsk(answer) {
  if (!askResolve) return;
  $('#ask').hidden = true;
  const done = askResolve;
  askResolve = null;
  done(answer);
}

$('#ask-yes').addEventListener('click', () => closeAsk(true));
$('#ask-no').addEventListener('click', () => closeAsk(false));
$('#ask').addEventListener('click', (e) => { if (e.target.id === 'ask') closeAsk(false); });

// Esc/Enter 가 아래(패널 닫기 등)로 흘러가지 않도록 캡처 단계에서 잡는다
document.addEventListener('keydown', (e) => {
  if (!askResolve) return;
  if (e.key === 'Escape' || e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    closeAsk(e.key === 'Enter');
  }
}, true);

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

async function togglePin() {
  pinned = await api.setPinned(!pinned);
  applyPinUI();
  toast(pinned ? '📌 고정됨 — 마우스가 벗어나도 열려 있습니다' : '고정 해제됨');
}

api.onSettingsChanged((s) => {
  state.settings = { ...state.settings, ...s };
  applySettings();
  syncSettingsUI();
});

api.onOpenSettings(() => openSettingsSheet());

/*
 * 접혀 있는 동안 창은 클릭을 통과시킨다(setIgnoreMouseEvents). 그래도 mousemove는 들어오므로
 * 커서가 탭 띠 위에 있을 때만 창이 클릭을 받도록 메인에 알려준다.
 */
function hitsRect(el, x, y) {
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/*
 * 탭 보이기 모드
 *   always : 늘 보인다
 *   hover  : 커서가 가장자리에 닿았을 때만 나타난다
 *   hidden : 패널이 열려 있을 때만 보인다 (평소엔 화면에서 사라진다)
 */
function updateTabVisibility(cursorInStrip) {
  const mode = state.settings.tabVisibility || 'always';
  const show = mode === 'always' || expanded
            || (mode === 'hover' && (cursorInStrip || overStrip));
  app.classList.toggle('tabs-hidden', !show);
  return show;
}

window.addEventListener('mousemove', (e) => {
  const inStrip = hitsRect($('#tabstrip'), e.clientX, e.clientY);
  const visible = updateTabVisibility(inStrip);

  // 접혀 있는 동안엔 '보이는 탭 띠' 위에서만 클릭을 받는다.
  if (!expanded) {
    const catchClicks = inStrip && visible;
    if (catchClicks !== overTabs) {
      overTabs = catchClicks;
      api.setInteractive(catchClicks);
    }
  }

  if (!state.settings.peekOnHover || draggingTab || !visible) return;

  // 메모지는 '탭 제목' 위에 커서가 있을 때만 나온다. 띠의 빈 곳이나 ＋ 위에서는 나오지 않는다.
  const hovered = [...tabsEl.children].find((el) => hitsRect(el, e.clientX, e.clientY));
  if (!hovered) return;

  if (hovered.dataset.id !== state.dock.activeTabId) selectTab(hovered.dataset.id);
  setPanel(true);   // 포커스를 가져올지는 닫기 모드에 따라 메인이 정한다
});

// 커서가 창을 벗어났는지는 메인 프로세스가 감시한다(renderer 의 mouseleave 는 놓치는 경우가 있다).

// ─────────────────────────────────────────── 서식 명령

function exec(cmd, value = null) {
  editor.focus();
  document.execCommand(cmd, false, value);
  syncToolbarState();
  queueSave();
}

function syncToolbarState() {
  for (const btn of document.querySelectorAll('.tb[data-cmd]')) {
    let on = false;
    try { on = document.queryCommandState(btn.dataset.cmd); } catch { /* 지원 안 하는 명령 */ }
    btn.classList.toggle('active', on);
  }
}

document.addEventListener('mousedown', (e) => {
  // 툴바를 눌러도 에디터 선택 영역이 풀리지 않게 한다.
  // 다만 슬라이더·입력칸까지 막으면 드래그와 포커스가 아예 안 되므로 예외로 둔다.
  if (!e.target.closest('#toolbar, .popover')) return;
  if (e.target.closest('input, select, textarea')) return;
  e.preventDefault();
});

for (const btn of document.querySelectorAll('.tb[data-cmd], .popover.menu button[data-cmd]')) {
  btn.addEventListener('click', () => {
    exec(btn.dataset.cmd);
    closeAllPopovers();
  });
}

// ─────────────────────────────────────────── 팝오버

function closeAllPopovers() {
  for (const p of document.querySelectorAll('.popover')) p.hidden = true;
}

function openPopover(pop, anchor) {
  const wasOpen = !pop.hidden;
  closeAllPopovers();
  if (wasOpen) return;
  pop.hidden = false;
  const panelRect = $('#panel').getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(
    a.left - panelRect.left,
    panelRect.width - pop.offsetWidth - 8,
  ));
  pop.style.left = `${left}px`;
  pop.style.top = '';
  pop.style.bottom = `${panelRect.bottom - a.top + 6}px`;
}

for (const btn of document.querySelectorAll('.tb[data-pop]')) {
  btn.addEventListener('click', () => openPopover($(`#pop-${btn.dataset.pop}`), btn));
}

function buildSwatches(container, colors, onPick) {
  container.textContent = '';
  for (const c of colors) {
    const b = document.createElement('button');
    b.className = 'sw';
    b.dataset.color = c;
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => onPick(c));
    container.appendChild(b);
  }
}

buildSwatches($('#pop-fore'), TEXT_COLORS, (c) => {
  exec('foreColor', c);
  $('#fore-bar').style.background = c;
  closeAllPopovers();
});

// 밝은 바탕에는 어두운 글자를, 어두운 바탕에는 밝은 글자를 얹는다.
function readableOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return '#3b2a6b';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#3b2a6b' : '#ffffff';
}

// 툴바 왼쪽 아래 알약은 '지금 탭'의 색을 그대로 입는다.
// (탭 색만 바뀌고 알약은 그대로여서 둘이 따로 노는 문제를 막는다)
function syncChipColor() {
  const tab = activeTab();
  if (!tab) return;
  const c = tab.color || TAB_COLORS[0];
  const chip = $('#chip-tab');
  chip.style.background = c;
  chip.style.color = readableOn(c);
  chip.title = '탭 색상 바꾸기 (지금 ' + c + ')';
  for (const sw of $('#pop-tabcolor').querySelectorAll('.sw')) {
    sw.classList.toggle('on', String(sw.dataset.color).toLowerCase() === String(c).toLowerCase());
  }
}

buildSwatches($('#pop-tabcolor'), TAB_COLORS, (c) => {
  activeTab().color = c;
  renderTabs();
  syncChipColor();
  flushSave();
  closeAllPopovers();
});

$('#chip-tab').addEventListener('click', () => openPopover($('#pop-tabcolor'), $('#chip-tab')));

// ─────────────────────────────────────────── 이미지

function insertImage(src) {
  editor.focus();
  document.execCommand('insertHTML', false,
    `<img src="${src}" style="width:60%" alt="" /><br>`);
  queueSave();
}

async function pickImages() {
  const urls = await api.pickImages(Number.MAX_SAFE_INTEGER);
  urls.forEach(insertImage);
}

$('#btn-image').addEventListener('click', pickImages);

async function addImageFile(file) {
  const buf = await file.arrayBuffer();
  const ext = (file.name.split('.').pop() || file.type.split('/')[1] || 'png').toLowerCase();
  insertImage(await api.saveImage(buf, ext));
}

// ─────────────────────────────────────────── 첨부파일

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function prettySize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

/*
 * 첨부파일 칩을 넣는다.
 * data-file 에는 저장된 이름을 퍼센트 인코딩해서 넣는다. 원래 이름을 그대로 쓰게 되면서
 * 이름에 & 나 따옴표가 섞일 수 있는데, 인코딩해 두면 HTML 안에서 안전하고
 * 청소(pruneImages)나 내보내기가 이름을 되읽을 때도 어긋나지 않는다.
 */
function insertFileChip({ token, name, size }) {
  editor.focus();
  document.execCommand('insertHTML', false,
    `<span class="file-chip" contenteditable="false" data-file="${encodeURIComponent(token)}" `
    + `title="클릭해서 열기 · 우클릭하면 메뉴 (열기 · 폴더 · 삭제)">`
    + `📎<span class="fname">${escapeHtml(name)}</span>`
    + `<span class="fsize">${prettySize(size)}</span></span>&nbsp;`);
  queueSave();
}

async function addAttachment(file) {
  const buf = await file.arrayBuffer();
  insertFileChip(await api.saveFile(buf, file.name));
}

$('#btn-file').addEventListener('click', async () => {
  const saved = await api.pickFiles();
  saved.forEach(insertFileChip);
});

editor.addEventListener('drop', async (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) {
    try {
      if (f.type.startsWith('image/')) await addImageFile(f);
      else await addAttachment(f);
    } catch {
      // 폴더를 떨어뜨리면 내용을 읽을 수 없다. 조용히 아무 일도 안 하는 것보다 알려준다.
      toast(`'${f.name}' 은(는) 넣을 수 없습니다 (폴더인가요?)`);
    }
  }
});
editor.addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault();
});

// 에디터 바깥(툴바·탭 띠 등)에 파일을 떨어뜨리면 창이 그 파일로 이동해버린다. 통째로 막는다.
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => {
    if (!e.target.closest || !e.target.closest('#editor')) e.preventDefault();
  });
}

// 붙여넣기: 이미지는 파일로 저장, 그 외에는 서식 없는 텍스트로 (외부 HTML을 그대로 넣지 않는다)
editor.addEventListener('paste', async (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const fileItems = items.filter((i) => i.kind === 'file');
  e.preventDefault();

  if (fileItems.length) {
    for (const item of fileItems) {
      const file = item.getAsFile();
      if (!file) continue;
      if (file.type.startsWith('image/')) await addImageFile(file);
      else await addAttachment(file);
    }
    return;
  }
  const text = e.clipboardData.getData('text/plain');
  if (text) {
    document.execCommand('insertText', false, text);
    queueSave();
  }
});

// 이미지 클릭 → 크기 조절 팝오버
function deselectImage() {
  if (selectedImg) selectedImg.classList.remove('selected');
  selectedImg = null;
  $('#img-tools').hidden = true;
  $('#img-handle').hidden = true;
}

/** 손잡이를 선택된 이미지의 오른쪽 아래 모서리에 붙인다. 스크롤하면 같이 움직인다. */
function placeImageHandle() {
  const handle = $('#img-handle');
  if (!selectedImg) { handle.hidden = true; return; }

  const panelRect = $('#panel').getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();
  const r = selectedImg.getBoundingClientRect();

  // 이미지가 스크롤 밖으로 나가면 손잡이도 감춘다.
  if (r.bottom < editorRect.top || r.top > editorRect.bottom) { handle.hidden = true; return; }

  handle.hidden = false;
  handle.style.left = `${r.right - panelRect.left - 8}px`;
  handle.style.top = `${r.bottom - panelRect.top - 8}px`;
}

editor.addEventListener('scroll', placeImageHandle);
window.addEventListener('resize', placeImageHandle);

/* 손잡이 드래그: 커서가 움직인 만큼 이미지 폭을 늘리고 줄인다. */
(() => {
  const handle = $('#img-handle');
  let dragging = false;
  let startX = 0;
  let startPx = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (!selectedImg) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    dragging = true;
    startX = e.clientX;
    startPx = selectedImg.getBoundingClientRect().width;
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging || !selectedImg) return;
    const room = editor.clientWidth - 32;   // 좌우 여백을 뺀 실제 사용 가능 폭
    const px = Math.max(40, Math.min(room, startPx + (e.clientX - startX)));
    setImageWidth(Math.round((px / room) * 100));
    placeImageHandle();
  });

  function end(e) {
    if (!dragging) return;
    dragging = false;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    flushSave();
  }
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
})();

editor.addEventListener('click', async (e) => {
  // Ctrl+드래그로 글자 크기를 바꾼 직후라면, 뒤따라오는 클릭은 무시한다
  // (안 그러면 링크 위에서 끝냈을 때 브라우저가 열린다)
  if (fontScrubbed) { fontScrubbed = false; return; }

  const link = e.target.closest('a');
  if (link && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    api.openExternal(link.href);
    return;
  }

  const chip = e.target.closest('.file-chip');
  if (chip) {
    e.preventDefault();
    deselectImage();
    const res = await api.openFile(chip.dataset.file);
    if (res && res.ok === false && res.reason) toast(res.reason);
    return;
  }

  if (e.target.tagName === 'IMG') {
    deselectImage();
    selectedImg = e.target;
    selectedImg.classList.add('selected');
    const pct = Math.round(parseFloat(selectedImg.style.width) || 60);
    $('#img-size').value = pct;
    $('#img-size-val').textContent = `${pct}%`;

    const pop = $('#img-tools');
    pop.hidden = false;
    const panelRect = $('#panel').getBoundingClientRect();
    const r = selectedImg.getBoundingClientRect();
    pop.style.bottom = '';
    pop.style.top = `${Math.min(r.bottom - panelRect.top + 6, panelRect.height - pop.offsetHeight - 8)}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left - panelRect.left, panelRect.width - pop.offsetWidth - 8))}px`;
    placeImageHandle();
  } else {
    deselectImage();
  }
});

/*
 * 메모지 본문은 어디를 더블클릭하든 고정이 토글된다.
 * (본문 아래 빈 곳을 눌러도 브라우저는 가장 가까운 단어를 선택해버리기 때문에,
 *  '선택된 글자가 있으면 제외' 같은 조건으로는 빈 곳을 가려낼 수 없다.)
 * 이미지·첨부파일·링크는 각자 동작이 있으므로 제외한다.
 */
editor.addEventListener('dblclick', (e) => {
  if (e.target.closest('img, .file-chip, a')) return;
  togglePin();
});

/* ─── 첨부파일 우클릭 메뉴 ───
 * 예전에는 우클릭이 곧바로 폴더 열기였다. 그러다 보니 첨부를 지울 방법이
 * 사실상 없었다(칩을 백스페이스로 지우는 것 말고는). 메뉴로 바꿔 삭제를 넣는다.
 */
let menuChip = null;

editor.addEventListener('contextmenu', (e) => {
  const chip = e.target.closest('.file-chip');
  if (!chip) return;
  e.preventDefault();
  menuChip = chip;
  openPopover($('#pop-file'), chip);
});

/** 칩을 메모에서 빼고, 참조가 사라진 파일은 정리한다. */
function removeChip(chip) {
  chip.remove();
  flushSave();
  api.pruneImages();   // 아무도 안 쓰게 된 파일을 지운다
}

for (const btn of document.querySelectorAll('#pop-file button[data-file-act]')) {
  btn.addEventListener('click', async () => {
    const chip = menuChip;
    closeAllPopovers();
    menuChip = null;
    if (!chip) return;

    const token = chip.dataset.file;
    const name = (chip.querySelector('.fname') || {}).textContent || '첨부파일';

    if (btn.dataset.fileAct === 'open') {
      const res = await api.openFile(token);
      if (res && res.ok === false && res.reason) toast(res.reason);
      return;
    }
    if (btn.dataset.fileAct === 'reveal') { api.revealFile(token); return; }

    const ok = await askConfirm(`'${name}' 을(를) 지울까요?
메모에서 빠지고 저장된 파일도 지워집니다.`,
      { danger: true, yes: '삭제' });
    if (!ok) return;
    removeChip(chip);
    toast(`'${name}' 을(를) 지웠습니다`);
  });
}

/*
 * 탐색기에서 첨부파일을 직접 지웠을 때, 메모에 남은 칩은 눌러도 아무것도 열리지 않는
 * 껍데기가 된다. 실제로 없어진 것만 골라 조용히 걷어낸다.
 */
async function syncFileChips() {
  const chips = [...editor.querySelectorAll('.file-chip')];
  if (!chips.length) return;

  const missing = await api.missingFiles(chips.map((c) => c.dataset.file));
  if (!missing.length) return;

  const gone = new Set(missing);
  const names = [];
  for (const chip of chips) {
    if (!gone.has(chip.dataset.file)) continue;
    names.push((chip.querySelector('.fname') || {}).textContent || '첨부파일');
    chip.remove();
  }
  if (!names.length) return;

  flushSave();
  toast(names.length === 1
    ? `'${names[0]}' 파일이 없어져 메모에서도 뺐습니다`
    : `없어진 첨부 ${names.length}개를 메모에서 뺐습니다`);
}

// 폴더가 바뀌면(= 밖에서 지웠을 수 있으면) 지금 보고 있는 메모를 정리한다
api.onFilesChanged(() => { syncFileChips(); });

/* ─── 글자 크기 바로 바꾸기 ───
 * 설정까지 들어가지 않고 그 자리에서 조절한다. 폭을 모서리 드래그로 바꾸는 것과 같은 결이고,
 * 폭과 마찬가지로 '이 메모만' 에 적용된다.
 *
 *   Ctrl + 위아래 드래그 : 끌면서 바로 커지고 작아진다 (위로 크게, 아래로 작게)
 *   Ctrl + 휠           : 한 칸씩
 */
const MIN_FONT = 11;      // 설정 슬라이더와 같은 범위
const MAX_FONT = 28;
const FONT_DRAG_PX = 8;   // 이만큼 끌 때마다 1px

let fontScrubbed = false; // 방금 끌어서 바꿨는지 (뒤따르는 click 을 걸러내려고)

function applyFontSize(px) {
  const v = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round(px)));
  const tab = activeTab();
  if (!tab || tab.fontSize === v) return v;
  tab.fontSize = v;         // 폭과 같이 '이 메모만' 에 붙는다
  applySettings();
  toast(`글자 크기 ${v}px`);
  return v;
}

/** 조절이 끝났을 때 한 번만 저장하고 설정 화면 표시도 맞춘다. */
function commitFontSize() {
  flushSave();
  if (!$('#settings').hidden) syncSettingsUI();
}

(() => {
  let scrubbing = false;
  let startY = 0;
  let startSize = 0;

  editor.addEventListener('pointerdown', (e) => {
    fontScrubbed = false;
    if (!e.ctrlKey || e.button !== 0) return;
    e.preventDefault();                       // 글자 선택 대신 크기 조절
    scrubbing = true;
    startY = e.clientY;
    startSize = effFontSize();
    // 포인터가 이미 놓인 뒤면 예외가 난다. 붙잡지 못해도 조절 자체는 진행한다.
    try { editor.setPointerCapture(e.pointerId); } catch { /* 못 붙잡아도 괜찮다 */ }
  });

  editor.addEventListener('pointermove', (e) => {
    if (!scrubbing) return;
    const steps = Math.round((startY - e.clientY) / FONT_DRAG_PX);   // 위로 끌면 커진다
    if (!steps && !fontScrubbed) return;
    fontScrubbed = true;
    applyFontSize(startSize + steps);
  });

  function end(e) {
    if (!scrubbing) return;
    scrubbing = false;
    try {
      if (e && editor.hasPointerCapture(e.pointerId)) editor.releasePointerCapture(e.pointerId);
    } catch { /* 이미 놓였다 */ }
    if (fontScrubbed) commitFontSize();
  }
  editor.addEventListener('pointerup', end);
  editor.addEventListener('pointercancel', end);

  // Ctrl+휠 은 어디서나 쓰는 방식이라 같이 지원한다
  let wheelTimer = null;
  editor.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();                       // 페이지 확대 대신 글자 크기
    applyFontSize(effFontSize() + (e.deltaY < 0 ? 1 : -1));
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(commitFontSize, 250);   // 굴리는 동안 매번 저장하지 않는다
  }, { passive: false });
})();

function setImageWidth(pct) {
  if (!selectedImg) return;
  const v = Math.max(5, Math.min(100, pct));
  selectedImg.style.width = `${v}%`;
  $('#img-size').value = v;
  $('#img-size-val').textContent = `${v}%`;
  placeImageHandle();
  queueSave();
}

$('#img-size').addEventListener('input', (e) => setImageWidth(Number(e.target.value)));
for (const b of document.querySelectorAll('#img-tools .ratios button')) {
  b.addEventListener('click', () => setImageWidth(Number(b.dataset.ratio)));
}
$('#img-delete').addEventListener('click', () => {
  if (!selectedImg) return;
  selectedImg.remove();
  deselectImage();
  flushSave();
  api.pruneImages();
});

// ─────────────────────────────────────────── 에디터 입력

editor.addEventListener('input', queueSave);
editor.addEventListener('keyup', syncToolbarState);
editor.addEventListener('mouseup', syncToolbarState);

// 링크 자동 인식: URL 뒤에 공백/엔터를 치면 링크로 바꾼다.
editor.addEventListener('keydown', (e) => {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  if (node.parentElement.closest('a')) return;

  const before = node.textContent.slice(0, sel.anchorOffset);
  const m = before.match(/(https?:\/\/[^\s]+)$/);
  if (!m) return;

  const range = document.createRange();
  range.setStart(node, sel.anchorOffset - m[1].length);
  range.setEnd(node, sel.anchorOffset);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('createLink', false, m[1]);
  sel.collapseToEnd();
});

// 탭 이름 편집
tabNameEl.addEventListener('input', () => {
  const name = tabNameEl.value.trim() || '메모';
  activeTab().name = name;
  chipLabel.textContent = name;
  renderTabs();
  queueSave();
});
tabNameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); editor.focus(); }
});

$('#add-tab').addEventListener('click', addTab);

// ─────────────────────────────────────────── 헤더 버튼

$('#btn-close').addEventListener('click', () => setPanel(false));
$('#btn-pin').addEventListener('click', togglePin);

// 제목 표시줄(빈 곳)을 더블클릭해도 고정된다. 이름 입력칸과 버튼은 제외.
$('#panel-head').addEventListener('dblclick', (e) => {
  if (e.target.closest('input, button')) return;
  togglePin();
});
function openSettingsSheet() {
  closeAllPopovers();
  $('#search').hidden = true;
  $('#settings').hidden = false;
  // 휴지통·백업·저장 위치는 열 때마다 최신 상태를 다시 읽는다.
  renderTrash();
  renderBackups();
  renderDataLocation();
}

$('#btn-settings').addEventListener('click', openSettingsSheet);
$('#settings-close').addEventListener('click', () => { $('#settings').hidden = true; });
$('#btn-quit').addEventListener('click', () => { flushSave(); api.quit(); });

// ─────────────────────────────────────────── 폭 (드래그 / 설정 공용)

function clampWidth(w) {
  return Math.max(MIN_PANEL_W, Math.min(MAX_PANEL_W, Math.round(Number(w) || 0)));
}

/** 설정 화면의 숫자칸·슬라이더 표시만 갱신한다. (창 크기는 건드리지 않는다) */
function showWidth(w) {
  $('#panel-width').value = w;
  $('#panel-width-num').value = w;
}

/**
 * 확정된 폭을 저장한다.
 * forceOwn(모서리 드래그)이면 무조건 지금 메모에만 적용하고 '이 메모만'을 자동으로 켠다.
 * 설정 화면에서 바꿀 때는 '이 메모만' 체크 상태를 따른다.
 */
function persistWidth(w, { forceOwn = false } = {}) {
  const tab = activeTab();
  if (forceOwn || tab.panelWidth != null) {
    tab.panelWidth = w;
    flushSave();
  } else {
    state.settings.panelWidth = w;
    api.saveSettings(state.settings);
  }
  syncSettingsUI();
}

/** 폭을 화면에 반영하고 저장까지 한다. */
function commitWidth(w) {
  const v = clampWidth(w);
  api.useWidth(v);
  persistWidth(v);
}

// ─────────────────────────────────────────── 폭 드래그

(() => {
  const grip = $('#grip');
  const panel = $('#panel');
  let dragging = false;

  /*
   * 폭은 '고정된 기준선에서 커서까지의 거리'로 잰다. 이동량 누적이 아니라서 드래그가 어긋나지 않는다.
   * 기준선(= 패널의 바깥쪽 모서리, 화면 가장자리에 붙어 있어 움직이지 않는다)은 드래그 시작 때 한 번만 구한다.
   */
  let anchorX = 0;

  function readAnchor() {
    const tabW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tab-w'), 10) || 34;
    anchorX = state.dock.edge === 'left'
      ? window.screenX + tabW
      : window.screenX + window.outerWidth - tabW;
  }

  function widthAt(screenX) {
    const w = state.dock.edge === 'left' ? screenX - anchorX : anchorX - screenX;
    return Math.max(MIN_PANEL_W, Math.min(MAX_PANEL_W, Math.round(w)));
  }

  function applyWidth(w) {
    panel.style.width = `${w}px`;
    showWidth(w);
    draggedWidth = w;
  }

  let draggedWidth = 0;

  grip.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);  // 커서가 그립 밖으로 나가도 계속 따라온다
    panel.classList.add('resizing');
    grip.classList.add('dragging');

    await api.beginResize();      // 창을 최대 폭으로 넓혀 커서가 창 밖으로 나가지 않게 한다
    readAnchor();                 // 창이 넓어진 뒤의 좌표로 기준선을 잡는다
    dragging = true;
    applyWidth(widthAt(e.screenX));
  });

  grip.addEventListener('pointermove', (e) => {
    if (dragging) applyWidth(widthAt(e.screenX));
  });

  async function commit(width) {
    const w = await api.endResize(width);  // 창이 실제 폭으로 줄어든 뒤에
    panel.style.width = '';                // CSS 가 다시 폭을 잡게 한다 (중간 프레임 깜빡임 방지)
    persistWidth(w, { forceOwn: true });   // 모서리 드래그는 언제나 '이 메모만'
  }

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    if (e && grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    panel.classList.remove('resizing');
    grip.classList.remove('dragging');
    commit(draggedWidth || effPanelWidth());
  }

  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  // 더블클릭하면 기본 폭으로
  grip.addEventListener('dblclick', () => {
    applyWidth(380);
    commit(380);
  });
})();

// ─────────────────────────────────────────── 설정 시트

function syncSettingsUI() {
  const s = state.settings;
  for (const sw of $('#bg-swatches').children) sw.classList.toggle('on', sw.title === s.bgColor);
  for (const sw of $('#text-swatches').children) sw.classList.toggle('on', sw.title === s.textColor);
  $('#bg-custom').value = /^#[0-9a-f]{6}$/i.test(s.bgColor) ? s.bgColor : '#ffffff';
  $('#text-custom').value = /^#[0-9a-f]{6}$/i.test(s.textColor) ? s.textColor : '#000000';
  $('#font-family').value = s.fontFamily;

  const tab = activeTab();
  const fontOwn = tab && tab.fontSize != null;
  const widthOwn = tab && tab.panelWidth != null;

  $('#font-size-own').checked = fontOwn;
  $('#font-size-label').textContent = fontOwn ? `'${tab.name}' 글자 크기` : '기본 글자 크기';
  $('#font-size').value = effFontSize();
  $('#font-size-val').textContent = `${effFontSize()}px`;

  $('#width-own').checked = widthOwn;
  $('#width-label').textContent = widthOwn ? `'${tab.name}' 폭` : '기본 패널 폭';
  showWidth(effPanelWidth());

  $('#opacity').value = Math.round(s.opacity * 100);
  $('#opacity-val').textContent = `${Math.round(s.opacity * 100)}%`;
  $('#peek-hover').checked = s.peekOnHover;
  $('#free-layout').checked = s.freeTabLayout !== false;
  for (const b of document.querySelectorAll('[data-vis]')) {
    b.classList.toggle('on', b.dataset.vis === (s.tabVisibility || 'always'));
  }
  $('#tabs-reset').disabled = s.freeTabLayout === false;
  $('#startup').checked = s.launchOnStartup;
  $('#fore-bar').style.background = s.textColor;
  for (const b of document.querySelectorAll('[data-edge]')) {
    b.classList.toggle('on', b.dataset.edge === state.dock.edge);
  }
  for (const b of document.querySelectorAll('[data-close]')) {
    b.classList.toggle('on', b.dataset.close === s.closeMode);
  }
  for (const b of document.querySelectorAll('[data-speed]')) {
    b.classList.toggle('on', b.dataset.speed === (s.closeSpeed || 'fast'));
  }
  const pct = Math.round((Number(state.dock.tabsOffset) || 0) * 100);
  $('#tabs-offset').value = pct;
  $('#tabs-offset-val').textContent = pct === 0 ? '맨 위' : pct === 100 ? '맨 아래' : `${pct}%`;

  const sel = $('#display-select');
  if (sel.options.length) sel.value = String(state.dock.displayId ?? primaryDisplayId ?? '');

  $('#shortcuts-on').checked = s.shortcutsEnabled !== false;
  $('#shortcut-field').classList.toggle('off', s.shortcutsEnabled === false);
  for (const btn of document.querySelectorAll('.keybtn')) {
    if (btn.classList.contains('capturing')) continue;
    btn.textContent = prettyAccel((s.shortcuts || {})[btn.dataset.sc]);
  }
  // 안내글의 단축키도 지금 설정된 값으로 채운다
  for (const el of document.querySelectorAll('[data-help-sc]')) {
    el.textContent = prettyAccel((s.shortcuts || {})[el.dataset.helpSc]);
  }
}

// ─────────────────────────────────────────── 가장자리(dock)

function showDockMsg(text) {
  const el = $('#dock-msg');
  el.textContent = text || '';
  el.hidden = !text;
  if (text) setTimeout(() => { el.hidden = true; }, 4000);
}

/** 이 창이 붙는 자리(모니터·좌우)를 바꾼다. 이미 다른 메모지가 쓰는 자리면 거절된다. */
async function changeDock(patch) {
  const res = await api.updateDock(patch);
  if (!res.ok) {
    showDockMsg(res.reason || '바꿀 수 없습니다.');
    syncSettingsUI();
    return;
  }
  Object.assign(state.dock, res.dock);
  applySettings();
  syncSettingsUI();
}

function renderDockList(list) {
  state.docks = list;
  const wrap = $('#dock-list');
  wrap.textContent = '';

  for (const d of list) {
    const row = document.createElement('div');
    row.className = 'dock-item' + (d.id === state.dock.id ? ' current' : '');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = d.label;
    row.appendChild(name);

    if (d.id === state.dock.id) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '이 메모지';
      row.appendChild(badge);
    }

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '삭제';
    del.title = '이 가장자리의 메모를 모두 지웁니다';
    del.disabled = list.length <= 1;
    del.addEventListener('click', async () => {
      const ok = await askConfirm(`'${d.label}' 가장자리를 지울까요?\n그 안의 메모도 모두 사라집니다.`,
        { danger: true, yes: '삭제' });
      if (!ok) return;
      const res = await api.removeDock(d.id);
      if (!res.ok) showDockMsg(res.reason);
    });
    row.appendChild(del);

    wrap.appendChild(row);
  }

  const max = Math.max(1, displayCount) * 2;
  $('#dock-count').textContent = `${list.length} / ${max}`;
  $('#dock-add').disabled = list.length >= max;
}

function renderDisplayOptions(list) {
  displayCount = list.length;
  primaryDisplayId = (list.find((d) => d.isPrimary) || {}).id ?? null;
  const sel = $('#display-select');
  sel.textContent = '';
  for (const d of list) {
    const o = document.createElement('option');
    o.value = String(d.id);
    o.textContent = d.label;
    sel.appendChild(o);
  }
  sel.value = String(state.dock.displayId ?? primaryDisplayId ?? '');
}

function bindSettings() {
  buildSwatches($('#bg-swatches'), BG_COLORS, (c) => { saveSettings({ bgColor: c }); syncSettingsUI(); });
  buildSwatches($('#text-swatches'), TEXT_COLORS, (c) => { saveSettings({ textColor: c }); syncSettingsUI(); });

  $('#bg-custom').addEventListener('input', (e) => saveSettings({ bgColor: e.target.value }));
  $('#text-custom').addEventListener('input', (e) => saveSettings({ textColor: e.target.value }));

  const sel = $('#font-family');
  for (const f of FONTS) {
    const o = document.createElement('option');
    o.value = f;
    o.textContent = f;
    o.style.fontFamily = `'${f}', sans-serif`;
    sel.appendChild(o);
  }
  sel.addEventListener('change', (e) => saveSettings({ fontFamily: e.target.value }));

  $('#font-size').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#font-size-val').textContent = `${v}px`;
    if ($('#font-size-own').checked) {
      activeTab().fontSize = v;
      applySettings();
      queueSave();
    } else {
      saveSettings({ fontSize: v });
    }
  });

  $('#font-size-own').addEventListener('change', (e) => {
    activeTab().fontSize = e.target.checked ? effFontSize() : null;
    applySettings();
    flushSave();
    syncSettingsUI();
  });

  $('#opacity').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#opacity-val').textContent = `${v}%`;
    saveSettings({ opacity: v / 100 });
  });

  /*
   * 슬라이더를 끄는 동안 창 크기를 실시간으로 바꾸면, 패널이 줄어들면서 슬라이더 자체가
   * 커서 밑에서 움직여 미세 조절이 불가능해진다. 그래서 끄는 동안엔 숫자만 바뀌고
   * 손을 뗄 때(change) 실제로 적용한다.
   */
  $('#panel-width').addEventListener('input', (e) => {
    $('#panel-width-num').value = Number(e.target.value);
  });
  $('#panel-width').addEventListener('change', (e) => commitWidth(e.target.value));

  $('#panel-width-num').addEventListener('change', (e) => commitWidth(e.target.value));
  $('#width-minus').addEventListener('click', () => commitWidth(effPanelWidth() - 10));
  $('#width-plus').addEventListener('click', () => commitWidth(effPanelWidth() + 10));

  $('#width-own').addEventListener('change', (e) => {
    const current = effPanelWidth();
    if (e.target.checked) {
      activeTab().panelWidth = current;
      flushSave();
    } else {
      activeTab().panelWidth = null;
      flushSave();
      api.useWidth(state.settings.panelWidth);   // 전체 기본값으로 돌아간다
    }
    syncSettingsUI();
  });

  for (const b of document.querySelectorAll('[data-edge]')) {
    b.addEventListener('click', () => changeDock({ edge: b.dataset.edge }));
  }

  for (const b of document.querySelectorAll('[data-close]')) {
    b.addEventListener('click', () => { saveSettings({ closeMode: b.dataset.close }); syncSettingsUI(); });
  }

  $('#display-select').addEventListener('change', (e) => changeDock({ displayId: Number(e.target.value) }));
  $('#dock-add').addEventListener('click', async () => {
    const res = await api.addDock();
    if (!res.ok) showDockMsg(res.reason);
  });

  $('#free-layout').addEventListener('change', (e) => {
    saveSettings({ freeTabLayout: e.target.checked });
    if (!e.target.checked) for (const tab of state.dock.tabs) tab.top = null;
    flushSave();
    layoutTabs();
    syncSettingsUI();
  });
  $('#tabs-reset').addEventListener('click', resetTabPositions);
  $('#tabs-offset').addEventListener('input', (e) => setTabsOffset(Number(e.target.value) / 100));
  $('#tabs-offset').addEventListener('change', () => setTabsOffset(state.dock.tabsOffset, { save: true }));

  // 닫는 속도 · 탭 보이기 · 잠시 숨기기.
  // (이 셋은 화면을 다시 그릴 때마다 핸들러가 겹쳐 붙던 자리였다. 시작할 때 한 번만 붙인다)
  for (const b of document.querySelectorAll('[data-speed]')) {
    b.addEventListener('click', () => { saveSettings({ closeSpeed: b.dataset.speed }); syncSettingsUI(); });
  }

  for (const b of document.querySelectorAll('[data-vis]')) {
    b.addEventListener('click', () => {
      saveSettings({ tabVisibility: b.dataset.vis });
      updateTabVisibility(false);
      syncSettingsUI();
      if (b.dataset.vis === 'hidden') toast('트레이 아이콘이나 열기 단축키로 부를 수 있습니다');
    });
  }

  $('#hide-now').addEventListener('click', () => api.hideAll());

  $('#peek-hover').addEventListener('change', (e) => saveSettings({ peekOnHover: e.target.checked }));
  $('#startup').addEventListener('change', (e) => saveSettings({ launchOnStartup: e.target.checked }));
}

// ─────────────────────────────────────────── 날짜·시간 넣기 (F5)

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 메모장(notepad)의 F5 처럼, 지금 날짜와 시간을 글자로 만든다. */
function stamp({ date = true, time = true } = {}) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const parts = [];

  if (date) parts.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} (${WEEKDAYS[d.getDay()]})`);
  if (time) {
    const h = d.getHours();
    parts.push(`${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${pad(d.getMinutes())}`);
  }
  return parts.join(' ');
}

function insertStamp(opts) {
  if (!$('#settings').hidden || !$('#search').hidden || askResolve) return false;
  if (!expanded) setPanel(true, { focus: true });

  editor.focus();
  const sel = window.getSelection();
  // 커서가 메모 안에 없으면 맨 끝에 붙인다
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  document.execCommand('insertText', false, stamp(opts));
  queueSave();
  return true;
}

// ─────────────────────────────────────────── 통합 검색

(() => {
  const sheet = $('#search');
  const input = $('#search-input');
  const list = $('#search-results');
  let timer = null;

  function open() {
    closeAllPopovers();
    $('#settings').hidden = true;
    sheet.hidden = false;
    input.value = '';
    list.textContent = '';
    $('#search-hint').hidden = false;
    input.focus();
  }

  function close() {
    sheet.hidden = true;
    editor.focus();
  }

  /** 찾은 글자를 굵게 표시하되, 원문은 항상 텍스트로만 넣는다(HTML 주입 방지). */
  function renderSnippet(el, text, query) {
    const at = text.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0 || !query) { el.textContent = text; return; }
    el.append(
      text.slice(0, at),
      Object.assign(document.createElement('mark'), { textContent: text.slice(at, at + query.length) }),
      text.slice(at + query.length),
    );
  }

  async function run() {
    const q = input.value.trim();
    $('#search-hint').hidden = !!q;
    list.textContent = '';
    if (!q) return;

    // 방금 친 글자도 찾을 수 있도록, 저장 대기 중인 내용을 먼저 확정한다
    if (saveTimer) await flushSave();
    const hits = await api.search(q);
    if (!hits.length) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = '찾는 내용이 없습니다.';
      list.appendChild(p);
      return;
    }

    for (const hit of hits) {
      const btn = document.createElement('button');
      btn.className = 'hit';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = hit.color || '#ddd';
      btn.appendChild(dot);

      const body = document.createElement('div');
      body.className = 'body';

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = hit.tabName;
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = hit.dockLabel + (hit.dockId === state.dock.id ? '' : ' · 다른 가장자리');
      title.appendChild(where);

      const snip = document.createElement('div');
      snip.className = 'snip';
      renderSnippet(snip, hit.snippet, q);

      body.append(title, snip);
      btn.appendChild(body);

      btn.addEventListener('click', () => {
        close();
        if (hit.dockId === state.dock.id) selectTab(hit.tabId);
        else api.openSearchHit({ dockId: hit.dockId, tabId: hit.tabId });
      });
      list.appendChild(btn);
    }
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 150); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter') { const first = list.querySelector('.hit'); if (first) first.click(); }
  });
  $('#btn-search').addEventListener('click', () => (sheet.hidden ? open() : close()));
  $('#search-close').addEventListener('click', close);

  window.openSearch = open;   // Ctrl+F 에서 쓴다
})();

// ─────────────────────────────────────────── 휴지통 / 백업 / 저장 위치

function timeAgo(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.round(hr / 24)}일 전`;
}

async function exportMemo(scope) {
  flushSave();                                  // 화면의 최신 내용을 먼저 확정
  const res = await api.exportMemo(scope);
  if (!res.ok) { if (res.reason) toast(res.reason); return; }
  toast(`${res.file} 로 내보냈습니다`);
}

async function renderTrash() {
  const items = await api.trashList();
  const wrap = $('#trash-list');
  wrap.textContent = '';

  $('#trash-count').textContent = items.length ? `${items.length}개` : '';
  $('#trash-days').textContent = String(state.settings.keepTrashDays ?? 30);
  $('#trash-empty').disabled = !items.length;

  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = '비어 있습니다.';
    wrap.appendChild(p);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'trash-item';

    const body = document.createElement('div');
    body.className = 'body';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${item.dockLabel} · ${timeAgo(item.deletedAt)} 삭제`;
    const snip = document.createElement('div');
    snip.className = 'snip';
    snip.textContent = item.preview || '(내용 없음)';
    body.append(title, meta, snip);

    const restore = document.createElement('button');
    restore.className = 'restore';
    restore.textContent = '되돌리기';
    restore.addEventListener('click', async () => {
      const res = await api.trashRestore(item.id);
      renderTrash();
      if (res && res.ok && res.sameDock === false) toast(`'${res.label}' 가장자리로 되돌렸습니다`);
    });

    const purge = document.createElement('button');
    purge.className = 'purge';
    purge.textContent = '삭제';
    purge.title = '완전히 지웁니다';
    purge.addEventListener('click', async () => {
      const ok = await askConfirm(`'${item.name}' 을(를) 완전히 지울까요?\n되돌릴 수 없습니다.`,
        { danger: true, yes: '완전 삭제' });
      if (!ok) return;
      await api.trashDelete(item.id);
      renderTrash();
    });

    row.append(body, restore, purge);
    wrap.appendChild(row);
  }
}

async function renderDataLocation() {
  const loc = await api.dataLocation();
  $('#data-dir').textContent = loc.dir;
  $('#data-default').textContent = loc.isDefault
    ? '기본 위치를 쓰고 있습니다.'
    : `기본 위치: ${loc.defaultDir}`;
  $('#data-reset').disabled = loc.isDefault;
}

async function renderBackups() {
  const list = await api.backupList();
  $('#backup-count').textContent = list.length ? `${list.length}개 보관 중` : '';
  $('#backup-hours').value = String(state.settings.backupHours ?? 6);
  $('#backup-last').textContent = list.length
    ? `가장 최근 백업: ${timeAgo(list[0].at)} (${list[0].name})`
    : '아직 백업이 없습니다.';
}

function bindMaintenance() {
  $('#export-one').addEventListener('click', () => exportMemo('one'));
  $('#export-all').addEventListener('click', () => exportMemo('all'));

  $('#import-memo').addEventListener('click', async () => {
    const res = await api.importMemos();
    if (!res.ok) { if (res.reason) toast(res.reason); return; }

    flushSave();
    for (const memo of res.memos) {
      state.dock.tabs.push({
        id: `tab-${Date.now()}-${state.dock.tabs.length}`,
        name: memo.name,
        color: memo.color || TAB_COLORS[state.dock.tabs.length % TAB_COLORS.length],
        html: memo.html,
        panelWidth: null,
        fontSize: null,
        top: null,
        updatedAt: Date.now(),
      });
    }
    state.dock.activeTabId = state.dock.tabs[state.dock.tabs.length - 1].id;
    loadActiveIntoEditor();
    renderTabs();
    api.saveTabs({ tabs: state.dock.tabs, activeTabId: state.dock.activeTabId });
    toast(`메모 ${res.memos.length}개를 가져왔습니다`);
  });

  $('#trash-empty').addEventListener('click', async () => {
    const ok = await askConfirm('휴지통을 비울까요?\n되돌릴 수 없습니다.', { danger: true, yes: '비우기' });
    if (!ok) return;
    await api.trashEmpty();
    renderTrash();
  });

  $('#data-open').addEventListener('click', () => api.openDataFolder());

  $('#data-change').addEventListener('click', async () => {
    const res = await api.setDataLocation(false);
    if (res.ok === false && res.reason) toast(`옮기지 못했습니다: ${res.reason}`);
    renderDataLocation();
  });

  $('#data-reset').addEventListener('click', async () => {
    const ok = await askConfirm('저장 위치를 기본값으로 되돌릴까요?\n메모 파일도 함께 옮겨집니다.',
      { yes: '되돌리기' });
    if (!ok) return;
    const res = await api.setDataLocation(true);
    if (res.ok === false && res.reason) toast(`옮기지 못했습니다: ${res.reason}`);
    renderDataLocation();
  });

  $('#backup-hours').addEventListener('change', (e) => {
    saveSettings({ backupHours: Number(e.target.value) });
    renderBackups();
  });

  $('#backup-now').addEventListener('click', async () => {
    const res = await api.backupNow();
    if (!res.ok) toast(`백업 실패: ${res.reason}`);
    renderBackups();
  });

  $('#backup-open').addEventListener('click', () => api.openBackupFolder());
}

// ─────────────────────────────────────────── 단축키 설정

const NAMED_KEYS = ['Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown'];

/** KeyboardEvent 를 Electron accelerator 문자열로 바꾼다. 만들 수 없으면 null. */
function accelFrom(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;   // 수식키만 눌린 상태

  let key;
  if (e.key === ' ') key = 'Space';
  else if (e.key.length === 1) key = e.key.toUpperCase();
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
  else if (e.key.startsWith('Arrow')) key = e.key.slice(5);
  else if (NAMED_KEYS.includes(e.key)) key = e.key;
  else return null;

  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  // 수식키 없는 단일 키를 전역 단축키로 잡으면 다른 프로그램에서 그 키를 못 쓰게 된다.
  if (!mods.length && !/^F\d/.test(key)) return null;
  return [...mods, key].join('+');
}

function prettyAccel(accel) {
  if (!accel) return '없음';
  return accel.replace('Control', 'Ctrl').replace('Super', 'Win').split('+').join(' + ');
}

(() => {
  let capturing = null;   // 지금 키 입력을 기다리는 버튼

  function stopCapture() {
    if (!capturing) return;
    capturing.classList.remove('capturing');
    capturing = null;
    syncSettingsUI();
  }

  $('#shortcuts-on').addEventListener('change', (e) => {
    stopCapture();
    saveSettings({ shortcutsEnabled: e.target.checked });
    syncSettingsUI();
  });

  for (const btn of document.querySelectorAll('.keyclear')) {
    btn.addEventListener('click', async () => {
      const res = await api.setShortcuts({ [btn.dataset.sc]: null });
      state.settings.shortcuts = res.shortcuts;
      syncSettingsUI();
    });
  }

  for (const btn of document.querySelectorAll('.keybtn')) {
    btn.addEventListener('click', () => {
      const again = capturing === btn;
      stopCapture();
      if (again) return;
      capturing = btn;
      btn.classList.add('capturing');
      btn.textContent = '키를 누르세요…';
    });
  }

  // 캡처 단계에서 먼저 가로챈다. Esc 로 패널이 닫히거나 하는 걸 막기 위해.
  document.addEventListener('keydown', async (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') { stopCapture(); return; }

    const accel = accelFrom(e);
    if (!accel) return;                       // 아직 조합이 완성되지 않음

    const btn = capturing;
    const name = btn.dataset.sc;
    const res = await api.setShortcuts({ [name]: accel });
    state.settings.shortcuts = res.shortcuts;

    const failed = res.failed.includes(name);
    $('#shortcut-hint').innerHTML = failed
      ? `<b>${prettyAccel(accel)}</b> 은 다른 프로그램이 이미 쓰고 있어 등록하지 못했습니다. 다른 조합을 눌러보세요.`
      : '버튼을 누른 뒤 원하는 키 조합을 누르세요. <code>Esc</code> 로 취소.';
    btn.classList.toggle('failed', failed);
    stopCapture();
  }, true);
})();

// ─────────────────────────────────────────── 전역 단축키 / 시작

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#search').hidden) { $('#search').hidden = true; return; }
    if (!$('#settings').hidden) { $('#settings').hidden = true; return; }
    if (document.querySelector('.popover:not([hidden])')) { closeAllPopovers(); return; }
    setPanel(false);
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    flushSave();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    window.openSearch();
  }
  // F5: 날짜+시간 / Shift+F5: 날짜만 / Ctrl+F5: 시간만
  if (e.key === 'F5') {
    e.preventDefault();
    insertStamp({ date: !e.ctrlKey, time: !e.shiftKey });
  }
});

document.addEventListener('click', (e) => {
  // 이미지 팝오버는 에디터 쪽 핸들러가 직접 여닫는다.
  if (e.target.tagName === 'IMG') return;
  if (!e.target.closest('.popover') && !e.target.closest('[data-pop]') && !e.target.closest('#chip-tab')) {
    const keepImgTools = !$('#img-tools').hidden && selectedImg;
    closeAllPopovers();
    if (keepImgTools) $('#img-tools').hidden = false;
  }
});

window.addEventListener('beforeunload', flushSave);

api.onDisplaysChanged((list) => { renderDisplayOptions(list); renderDockList(state.docks || []); });
api.onDocksChanged((list) => renderDockList(list));
api.onNewTab(() => addTab());
api.onNextTab(() => {
  const i = state.dock.tabs.findIndex((t) => t.id === state.dock.activeTabId);
  selectTab(state.dock.tabs[(i + 1) % state.dock.tabs.length].id);
});

/** 저장 위치 변경·휴지통 복원처럼 데이터가 통째로 바뀌었을 때 화면을 다시 그린다. */
async function reloadState(selectTabId) {
  // 아직 저장되지 않은 편집이 있으면 먼저 확정한다.
  // 그러지 않으면 다시 불러오면서 방금 쓴 내용이 화면째 덮여 사라진다.
  if (saveTimer) await flushSave();
  state = await api.getState();
  if (selectTabId && state.dock.tabs.some((t) => t.id === selectTabId)) {
    state.dock.activeTabId = selectTabId;
  }
  applySettings();
  renderTabs();
  loadActiveIntoEditor();
  renderDockList(state.docks || []);
  syncSettingsUI();
  if (!$('#settings').hidden) { renderTrash(); renderBackups(); renderDataLocation(); }
}

api.onReload(({ selectTabId }) => reloadState(selectTabId));
api.onSelectTab((tabId) => selectTab(tabId));

(async function init() {
  state = await api.getState();       // { settings, dock, docks }
  applySettings();
  renderTabs();
  loadActiveIntoEditor();
  bindSettings();
  bindMaintenance();
  renderDisplayOptions(await api.listDisplays());
  renderDockList(state.docks);
  syncSettingsUI();
})();
