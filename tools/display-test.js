/**
 * 모니터 다시 찾기 단위 테스트.
 *   node tools/display-test.js
 *
 * 재부팅하면 윈도우가 모니터 id 를 새로 매기는 상황을 흉내 낸다.
 * 실제로 겪은 경우: 저장된 id 904708227 → 재부팅 뒤 모니터는 1546791665 / 3987148736,
 * 두 대 모두 이름이 'LG FHD' 라 이름으로도 못 가렸다.
 */
const { pickDisplay, hintOf, refreshDocks } = require('../src/main/displays');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
};

const mon = (id, x, label = 'LG FHD', width = 1920, height = 1080) => (
  { id, label, bounds: { x, y: 0, width, height } }
);

// 재부팅 전: 오른쪽 모니터를 골라 두었다
const before = [mon(111, 0), mon(904708227, 1920)];
const dock = { displayId: 904708227, displayHint: hintOf(before[1]) };

// 재부팅 뒤: id 가 전부 바뀌었다 (배치는 그대로)
const after = [mon(1546791665, 0), mon(3987148736, 1920)];

{
  const r = pickDisplay(after, 1546791665, dock);
  check('재부팅으로 id 가 바뀌어도 같은 모니터를 찾는다',
    r.display.id === 3987148736 && r.how === 'bounds', `${r.display.id} (${r.how})`);
}

{
  // 이름이 같은 모니터 두 대 — 이름으로는 못 가리므로 좌표가 가려야 한다
  const r = pickDisplay(after, 1546791665, dock);
  check('같은 모델 두 대여도 좌표로 가린다', r.display.bounds.x === 1920, JSON.stringify(r.display.bounds));
}

{
  // 단서가 없던 옛 데이터: id 도 없으면 어쩔 수 없이 주 모니터로
  const r = pickDisplay(after, 1546791665, { displayId: 904708227 });
  check('단서 없는 옛 데이터는 주 모니터로 물러난다', r.display.id === 1546791665 && r.how === 'fallback', r.how);
}

{
  // id 가 두 모니터 사이에서 서로 뒤바뀐 경우 — id 를 믿으면 반대편에 뜬다
  const swapped = [mon(904708227, 0), mon(111, 1920)];
  const r = pickDisplay(swapped, 904708227, dock);
  check('id 가 뒤바뀌어도 원래 자리의 모니터를 고른다', r.display.bounds.x === 1920 && r.how === 'bounds',
    `x=${r.display.bounds.x} (${r.how})`);
}

{
  // 해상도만 바꾼 경우: 크기는 달라도 자리가 같으면 같은 모니터
  const resized = [mon(1, 0), mon(2, 1920, 'LG FHD', 2560, 1440)];
  const r = pickDisplay(resized, 1, dock);
  check('해상도를 바꿔도 자리로 찾는다', r.display.id === 2 && r.how === 'position', r.how);
}

{
  // 배치를 바꿨지만 이름이 유일하면 이름으로
  const d2 = { displayId: 5, displayHint: hintOf(mon(5, 1920, 'DELL U2720Q')) };
  const moved = [mon(1, 0, 'LG FHD'), mon(9, -2560, 'DELL U2720Q', 2560, 1440)];
  const r = pickDisplay(moved, 1, d2);
  check('자리가 바뀌어도 이름이 유일하면 이름으로 찾는다', r.display.id === 9 && r.how === 'label', r.how);
}

{
  // 윈도우와 함께 켜지는 순서 그대로:
  //   ① 주 모니터 한 대만 먼저 잡힘 (이름이 같아서 '이름으로 찾았다'고 착각하기 쉽다)
  //   ② 잠시 뒤 두 번째 모니터가 잡힘
  const saved = { displayId: 904708227, displayHint: hintOf(before[1]) };
  const snapshot = JSON.stringify(saved);

  const booting = [mon(1546791665, 0)];
  const r1 = pickDisplay(booting, 1546791665, saved);
  check('① 한 대만 잡혔을 땐 일단 주 모니터에 둔다', r1.display.id === 1546791665, r1.how);

  const changed = refreshDocks([saved], booting, 1546791665);
  check('① 그 순간엔 저장된 선택을 덮어쓰지 않는다',
    changed === false && JSON.stringify(saved) === snapshot, JSON.stringify(saved));

  const changed2 = refreshDocks([saved], after, 1546791665);
  const r2 = pickDisplay(after, 1546791665, saved);
  check('② 두 번째 모니터가 잡히면 원래 모니터로 간다',
    r2.display.id === 3987148736 && r2.how === 'bounds', `${r2.display.id} (${r2.how})`);
  check('② 바뀐 id 로 고쳐 적는다', changed2 === true && saved.displayId === 3987148736, String(saved.displayId));
}

{
  // 단서가 없던 옛 데이터라도 id 가 살아 있으면 단서를 채워 둔다 → 다음 재부팅부터 안전
  const old = { displayId: 904708227 };
  const changed = refreshDocks([old], before, 111);
  check('옛 데이터에 단서를 채운다',
    changed === true && old.displayHint && old.displayHint.x === 1920, JSON.stringify(old.displayHint));

  // 그리고 실제로 재부팅하면
  const r = pickDisplay(after, 1546791665, old);
  check('채운 단서로 재부팅 뒤에도 찾는다', r.display.id === 3987148736, r.how);
}

{
  // 이름·자리만으로 찾은 건 저장하지 않는다
  const d2 = { displayId: 5, displayHint: hintOf(mon(5, 1920, 'DELL U2720Q')) };
  const snap = JSON.stringify(d2);
  const moved = [mon(1, 0, 'LG FHD'), mon(9, -2560, 'DELL U2720Q', 2560, 1440)];
  refreshDocks([d2], moved, 1);
  check('이름으로 찾은 건 임시로만 쓰고 저장하지 않는다', JSON.stringify(d2) === snap);
}

{
  const r = pickDisplay(after, 1546791665, { displayId: null });
  check('주 모니터를 따르는 가장자리는 주 모니터', r.display.id === 1546791665 && r.how === 'primary', r.how);
}

{
  // 같은 세션 안에서는 id 가 그대로다
  const r = pickDisplay(before, 111, { displayId: 904708227 });
  check('id 가 그대로면 id 로 찾는다', r.display.id === 904708227 && r.how === 'id', r.how);
}

{
  const h = hintOf(mon(7, 1920, 'LG FHD'));
  check('단서에 좌표·크기·이름이 담긴다',
    h.x === 1920 && h.y === 0 && h.width === 1920 && h.height === 1080 && h.label === 'LG FHD', JSON.stringify(h));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
