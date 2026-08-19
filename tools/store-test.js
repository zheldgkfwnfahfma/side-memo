/**
 * 저장소(store) 단위 테스트 — 특히 '데이터가 깨졌을 때 무엇을 지키는가'.
 *   node tools/store-test.js
 *
 * electron 없이 순수 로직만 확인한다. 임시 폴더를 쓰므로 실제 메모는 건드리지 않는다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
};

const dirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'smemo-store-'));
  dirs.push(d);
  return d;
}

// ── 평범한 경우 ──────────────────────────────────────────
{
  const dir = tempDir();
  const s = new Store(dir);
  check('첫 실행은 기본 메모로 시작', s.get().docks[0].tabs.length === 3);
  check('첫 실행은 손상으로 보지 않음', !s.lostData && !s.recoveredFrom);
  s.save();

  const again = new Store(dir);
  check('다시 열면 그대로 읽힌다', again.get().docks[0].tabs.length === 3);
  check('멀쩡한 파일은 백업에서 되살리지 않는다', !again.recoveredFrom);
}

// ── data.json 이 깨졌는데 백업이 있는 경우 ───────────────
{
  const dir = tempDir();
  const s = new Store(dir);
  s.get().docks[0].tabs[0].name = '중요한 메모';
  s.save();
  const backupName = path.basename(s.backup());

  fs.writeFileSync(s.file, '{ 이건 JSON 이 아니다', 'utf8');

  const revived = new Store(dir);
  check('깨진 파일은 백업에서 되살린다',
    revived.get().docks[0].tabs[0].name === '중요한 메모', revived.get().docks[0].tabs[0].name);
  check('어느 백업에서 되살렸는지 알려준다', revived.recoveredFrom === backupName, String(revived.recoveredFrom));
  check('되살렸으므로 데이터 유실 표시는 없다', revived.lostData === false);
  check('깨진 원본은 지우지 않고 남겨 둔다',
    fs.readdirSync(dir).some((n) => n.includes('.broken-')), fs.readdirSync(dir).join(', '));
}

// ── data.json 이 깨졌고 백업도 없는 경우 (가장 위험한 상황) ──
{
  const dir = tempDir();
  const s = new Store(dir);
  s.save();
  fs.writeFileSync(path.join(dir, 'images', 'keep.png'), Buffer.from('PNG'));
  fs.writeFileSync(path.join(dir, 'files', 'keep.docx'), Buffer.from('DOCX'));
  fs.writeFileSync(s.file, 'not json at all', 'utf8');

  const broken = new Store(dir);
  check('되살릴 백업이 없으면 유실을 표시한다', broken.lostData === true);
  check('그래도 앱은 뜬다 (빈 상태로 시작)', broken.get().docks.length === 1);

  broken.pruneImages();
  check('유실 상태에서는 이미지를 지우지 않는다',
    fs.existsSync(path.join(dir, 'images', 'keep.png')));
  check('유실 상태에서는 첨부파일도 지우지 않는다',
    fs.existsSync(path.join(dir, 'files', 'keep.docx')));
  check('깨진 원본을 남겨 둔다', fs.readdirSync(dir).some((n) => n.includes('.broken-')));
}

// ── 정상 상태에서는 안 쓰는 파일을 정리한다 ────────────────
{
  const dir = tempDir();
  const s = new Store(dir);
  fs.writeFileSync(path.join(dir, 'images', 'used.png'), Buffer.from('PNG'));
  fs.writeFileSync(path.join(dir, 'images', 'orphan.png'), Buffer.from('PNG'));
  fs.writeFileSync(path.join(dir, 'files', 'used.docx'), Buffer.from('DOCX'));
  s.get().docks[0].tabs[0].html =
    '<img src="sidememo-img://img/used.png"><span data-file="used.docx"></span>';
  s.save();
  s.pruneImages();
  check('쓰는 이미지는 남긴다', fs.existsSync(path.join(dir, 'images', 'used.png')));
  check('안 쓰는 이미지는 지운다', !fs.existsSync(path.join(dir, 'images', 'orphan.png')));
  check('쓰는 첨부파일은 남긴다', fs.existsSync(path.join(dir, 'files', 'used.docx')));
}

// ── 휴지통에 있는 메모의 파일도 지키는가 ──────────────────
{
  const dir = tempDir();
  const s = new Store(dir);
  fs.writeFileSync(path.join(dir, 'images', 'trashed.png'), Buffer.from('PNG'));
  const tab = s.makeTab('버린 메모', '#fff');
  tab.html = '<img src="sidememo-img://img/trashed.png">';
  s.trashTab(s.get().docks[0].id, '오른쪽', tab);
  s.pruneImages();
  check('휴지통 메모의 이미지는 지킨다', fs.existsSync(path.join(dir, 'images', 'trashed.png')));

  const back = s.restoreTab(tab.id);
  check('휴지통에서 되돌리면 원래 가장자리로 간다', back && back.dockId === s.get().docks[0].id);
  check('되돌린 메모가 목록에 있다', s.get().docks[0].tabs.some((t) => t.id === back.tabId));
}

for (const d of dirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
