const fs = require('fs');
const path = require('path');

let seq = 0;
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * userData 폴더의 data.json 한 파일에 전체 상태를 보관한다.
 * 쓰기는 임시 파일에 먼저 쓴 뒤 rename 해서, 저장 도중 종료돼도 파일이 깨지지 않게 한다.
 *
 * 구조
 *   settings : 모든 가장자리에 공통으로 적용되는 겉모습·동작 설정
 *   docks[]  : 화면 가장자리 하나 = 창 하나. 각자 자기 메모(tabs)를 가진다.
 */
const BACKUP_KEEP = 12;        // 보관할 백업 개수

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'data.json');
    this.imageDir = path.join(dataDir, 'images');
    this.fileDir = path.join(dataDir, 'files');
    this.backupDir = path.join(dataDir, 'backups');
    for (const dir of [dataDir, this.imageDir, this.fileDir, this.backupDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.data = this._load();
  }

  _defaults() {
    return {
      settings: {
        panelWidth: 380,          // 기본 패널 폭(px). 메모별로 따로 둘 수 있다
        opacity: 1,               // 0.3 ~ 1
        fontFamily: 'Malgun Gothic',
        fontSize: 15,
        bgColor: '#FBF3B0',
        textColor: '#4C1D95',
        peekOnHover: true,        // 탭 제목에 마우스를 올리면 열기
        wheelFontSize: true,      // Ctrl+휠로 글자 크기 조절
        tabVisibility: 'always',  // 'always' 항상 보임 | 'hover' 가장자리에 마우스를 대면 | 'hidden' 완전히 숨김
        freeTabLayout: true,      // 탭을 원하는 높이에 하나씩 둘 수 있게
        closeMode: 'mouse',       // 'mouse' 마우스가 벗어나면 | 'focus' 다른 창 클릭 시 | 'manual' 직접 닫을 때만
        closeSpeed: 'fast',       // 'instant' | 'fast' | 'normal' — 커서가 벗어난 뒤 접히는 빠르기
        launchOnStartup: false,
        shortcutsEnabled: true,
        backupHours: 6,           // 자동 백업 주기(시간). 0 이면 끔
        keepTrashDays: 30,        // 휴지통 보관 기간
        shortcuts: {
          // Ctrl+Alt+Space 는 한글 입력기 등이 선점하는 경우가 많아 M(emo) 을 기본으로 둔다.
          toggle: 'Control+Alt+M',
          newNote: 'Control+Alt+N',
          nextTab: 'Control+Alt+Right',
          hideAll: 'Control+Alt+H',
        },
      },
      docks: [this.makeDock({ edge: 'right', displayId: null, withSamples: true })],
      trash: [],
    };
  }

  /** panelWidth / fontSize 가 null 이면 전체 기본값을 따른다. 값이 있으면 그 메모에만 적용된다. */
  makeTab(name, color) {
    // top: 탭의 세로 위치(0~1). null 이면 다른 탭들과 함께 차곡차곡 쌓인다.
    return { id: uid('tab'), name, color, html: '', panelWidth: null, fontSize: null, top: null, updatedAt: Date.now() };
  }

  makeDock({ edge, displayId = null, withSamples = false }) {
    const tabs = withSamples
      ? [this.makeTab('TODO', '#C4B5FD'), this.makeTab('LIFE', '#E9E7E0'), this.makeTab('WORK', '#E9E7E0')]
      : [this.makeTab('메모', '#C4B5FD')];
    // tabsOffset: 탭 묶음의 세로 위치(0=맨 위, 1=맨 아래). 화면 높이가 달라도 비율로 유지된다.
    return { id: uid('dock'), edge, displayId, tabsOffset: 0, activeTabId: tabs[0].id, tabs };
  }

  /** BOM이 붙어 있으면 JSON.parse 가 그냥 던진다. 손으로 편집한 파일도 살려준다. */
  _readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  }

  _load() {
    const def = this._defaults();
    let parsed = null;

    // 첫 실행이면 파일이 없는 게 정상이다. 그때는 조용히 기본값으로 시작한다.
    this.startedEmpty = !fs.existsSync(this.file);
    this.recoveredFrom = null;
    this.lostData = false;

    if (!this.startedEmpty) {
      try {
        parsed = this._readJson(this.file);
      } catch {
        /*
         * 파일이 깨졌다. 여기서 그냥 기본값으로 시작해버리면
         *   ① 사용자의 메모가 통째로 사라진 것처럼 보이고
         *   ② 아무 메모도 참조하지 않는 상태가 되어 pruneImages 가 이미지·첨부를 전부 지운다.
         * 그래서 깨진 파일은 증거로 남기고, 가장 최근 백업에서 되살린다.
         */
        try { fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`); } catch { /* 못 옮겨도 진행 */ }
        for (const b of this.listBackups()) {
          try {
            parsed = this._readJson(path.join(this.backupDir, b.name));
            this.recoveredFrom = b.name;
            break;
          } catch { /* 이 백업도 깨졌으면 그 다음 것 */ }
        }
        // 되살릴 백업이 하나도 없다. 빈 상태로 시작하되 파일은 절대 지우지 않는다.
        if (!parsed) this.lostData = true;
      }
    }

    if (!parsed) return def;

    // 버전이 올라가며 추가된 설정 키가 없어도 동작하도록 기본값과 병합한다.
    const src = parsed.settings || {};
    const settings = { ...def.settings, ...src };
    settings.shortcuts = { ...def.settings.shortcuts, ...(src.shortcuts || {}) };

    // 예전 autoHide(불리언)를 closeMode 로 옮긴다.
    if (src.closeMode === undefined && 'autoHide' in src) {
      settings.closeMode = src.autoHide ? 'mouse' : 'manual';
    }
    // 가장자리·모니터는 설정이 아니라 dock 의 속성이 되었다.
    delete settings.autoHide;
    delete settings.edge;
    delete settings.displayId;

    let docks;
    if (Array.isArray(parsed.docks) && parsed.docks.length) {
      docks = parsed.docks;
    } else if (Array.isArray(parsed.tabs) && parsed.tabs.length) {
      // 가장자리가 하나뿐이던 시절의 파일 → dock 하나로 감싼다.
      docks = [{
        id: uid('dock'),
        edge: src.edge || 'right',
        displayId: src.displayId ?? null,
        activeTabId: parsed.activeTabId || parsed.tabs[0].id,
        tabs: parsed.tabs,
      }];
    } else {
      docks = def.docks;
    }

    return { settings, docks, trash: Array.isArray(parsed.trash) ? parsed.trash : [] };
  }

  // ── 휴지통 ────────────────────────────────────────────

  /** 지운 메모를 바로 없애지 않고 휴지통에 넣는다. */
  trashTab(dockId, dockLabel, tab) {
    this.data.trash.unshift({ ...tab, dockId, dockLabel, deletedAt: Date.now() });
    this.save();
  }

  /** 원래 있던 가장자리로 되돌린다. 그 가장자리가 사라졌으면 첫 번째로 보낸다. */
  restoreTab(tabId) {
    const i = this.data.trash.findIndex((t) => t.id === tabId);
    if (i < 0) return null;
    const [entry] = this.data.trash.splice(i, 1);

    const dock = this.getDock(entry.dockId) || this.data.docks[0];
    const { dockId, dockLabel, deletedAt, ...tab } = entry;
    // 같은 id 가 이미 있으면(수동 복구 등) 새 id 를 준다
    if (dock.tabs.some((t) => t.id === tab.id)) tab.id = uid('tab');
    dock.tabs.push(tab);
    this.save();
    return { dockId: dock.id, tabId: tab.id };
  }

  deleteFromTrash(tabId) {
    const i = this.data.trash.findIndex((t) => t.id === tabId);
    if (i < 0) return false;
    this.data.trash.splice(i, 1);
    this.save();
    return true;
  }

  emptyTrash() {
    this.data.trash = [];
    this.save();
  }

  /** 보관 기간이 지난 휴지통 항목을 정리한다. */
  purgeTrash() {
    const days = Number(this.data.settings.keepTrashDays) || 0;
    if (!days) return 0;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const before = this.data.trash.length;
    this.data.trash = this.data.trash.filter((t) => (t.deletedAt || 0) > cutoff);
    if (this.data.trash.length !== before) this.save();
    return before - this.data.trash.length;
  }

  // ── 백업 ─────────────────────────────────────────────

  /** data.json 스냅샷을 남기고 오래된 것부터 정리한다. */
  backup() {
    if (!fs.existsSync(this.file)) this.save();
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
                + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const target = path.join(this.backupDir, `data-${stamp}.json`);
    fs.copyFileSync(this.file, target);

    const olds = fs.readdirSync(this.backupDir)
      .filter((n) => n.startsWith('data-') && n.endsWith('.json'))
      .sort()
      .reverse();
    for (const name of olds.slice(BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(this.backupDir, name)); } catch { /* 다음 기회에 */ }
    }
    return target;
  }

  listBackups() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir)
      .filter((n) => n.startsWith('data-') && n.endsWith('.json'))
      .sort().reverse()
      .map((name) => {
        const st = fs.statSync(path.join(this.backupDir, name));
        return { name, size: st.size, at: st.mtimeMs };
      });
  }

  get() {
    return this.data;
  }

  getDock(id) {
    return this.data.docks.find((d) => d.id === id) || null;
  }

  addDock(edge, displayId) {
    const dock = this.makeDock({ edge, displayId });
    this.data.docks.push(dock);
    this.save();
    return dock;
  }

  removeDock(id) {
    if (this.data.docks.length <= 1) return false;   // 최소 하나는 남긴다
    const i = this.data.docks.findIndex((d) => d.id === id);
    if (i < 0) return false;
    this.data.docks.splice(i, 1);
    this.save();
    return true;
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** 어떤 메모에서도 참조하지 않는 이미지·첨부파일을 지운다. */
  pruneImages() {
    // 데이터를 못 읽어 빈 상태로 시작했다면 '아무도 안 쓰는 파일'이라는 판단 자체가 틀렸다.
    // 이럴 때 지우면 되돌릴 수 없으므로 그냥 둔다.
    if (this.lostData) return;

    const usedImages = new Set();
    const usedFiles = new Set();

    // 휴지통에 있는 메모도 아직 살아 있는 것으로 본다. 복원했을 때 이미지가 비면 안 되니까.
    const allTabs = [...this.data.docks.flatMap((d) => d.tabs), ...this.data.trash];
    for (const tab of allTabs) {
      const html = tab.html || '';
      for (const m of html.matchAll(/sidememo-img:\/\/img\/([^"'\s)]+)/g)) {
        usedImages.add(decodeURIComponent(m[1]));
      }
      for (const m of html.matchAll(/data-file="([^"]+)"/g)) {
        usedFiles.add(decodeURIComponent(m[1]));
      }
    }

    for (const [dir, used] of [[this.imageDir, usedImages], [this.fileDir, usedFiles]]) {
      for (const name of fs.readdirSync(dir)) {
        if (!used.has(name)) {
          try { fs.unlinkSync(path.join(dir, name)); } catch { /* 사용 중이면 다음 기회에 */ }
        }
      }
    }
  }
}

module.exports = { Store };
