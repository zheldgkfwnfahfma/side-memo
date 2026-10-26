/**
 * 모니터 다시 찾기 단위 테스트.
 *   node tools/display-test.js
 *
 * 재부팅하면 윈도우가 모니터 id 를 새로 매기는 상황을 흉내 낸다.
 * 실제로 겪은 경우: 저장된 id 904708227 → 재부팅 뒤 모니터는 1546791665 / 3987148736,
 * 두 대 모두 이름이 'LG FHD' 라 이름으로도 못 가렸다.
 */
const { pickDisplay, hintOf, refreshDocks, isWaiting } = require('../src/main/displays');

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
  const d2 = { displayId: 5, displayHint: { ...hintOf(mon(5, 1920, 'DELL U2720Q')), count: 2 } };
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
  const d2 = { displayId: 5, displayHint: { ...hintOf(mon(5, 1920, 'DELL U2720Q')), count: 2 } };
  const snap = JSON.stringify(d2);
  const moved = [mon(1, 0, 'LG FHD'), mon(9, -2560, 'DELL U2720Q', 2560, 1440)];
  refreshDocks([d2], moved, 1);
  check('이름으로 찾은 건 임시로만 쓰고 저장하지 않는다', JSON.stringify(d2) === snap);
}

// ── 잠금·절전에서 깨어날 때 (10월 26일 실제로 겪은 것) ──
// 오른쪽 메모는 오른쪽 모니터, 왼쪽 메모는 주 모니터에 두었는데, 아침에 잠금을 풀고 나니
// 오른쪽 메모가 주 모니터로 넘어와 저장까지 돼 버렸다 (백업: right@16516299 hint x=0).
// 깨어나는 순서: 오른쪽 모니터만 먼저 x=0 에 혼자 잡힘 → 몇 초 뒤 주 모니터가 켜지며 원래 배치로.
{
  const { confirmableId } = require('../src/main/displays');
  const P = 16516299, S = 854308167;
  const normal = [mon(P, 0), mon(S, 1920)];
  const sOnlyAt0 = [mon(S, 0)];                 // 주 모니터가 아직 안 켜짐
  const swapped = [mon(S, 0), mon(P, 1920)];    // 잠깐 자리가 뒤바뀌어 잡힘

  const right = { displayId: S, displayHint: { ...hintOf(mon(S, 1920)), count: 2 } };
  const left = { displayId: P, displayHint: { ...hintOf(mon(P, 0)), count: 2 } };
  const saved = JSON.stringify([right, left]);
  const session = new Map();
  const where = (list, dock, settled = true) => {
    const r = pickDisplay(list, list[0].id, dock, { sessionId: session.get(dock) ?? null, settled });
    const id = confirmableId(r, list, dock, settled);
    if (id != null) session.set(dock, id);
    return r;
  };

  where(normal, right); where(normal, left);
  check('평소엔 번호를 확인해 둔다', session.get(right) === S && session.get(left) === P);

  // ① 오른쪽 모니터만 x=0 에 혼자 잡힘
  let r = where(sOnlyAt0, right, false);
  let l = where(sOnlyAt0, left, false);
  check('① 오른쪽 메모는 오른쪽 모니터를 따라간다 (자리가 x=0 이어도)', r.display.id === S, r.how);
  check('① 왼쪽 메모는 같은 자리(x=0)의 다른 모니터로 가지 않고 기다린다', isWaiting(l), l.how);
  refreshDocks([right, left], sOnlyAt0, S, { settled: false });
  refreshDocks([right, left], sOnlyAt0, S, { settled: true });
  check('① 그 순간의 배치를 저장하지 않는다', JSON.stringify([right, left]) === saved);

  // ② 잠깐 자리가 뒤바뀌어 잡힘
  r = where(swapped, right, false);
  l = where(swapped, left, false);
  check('② 자리가 뒤바뀌어도 각자 원래 모니터를 따라간다', r.display.id === S && l.display.id === P, `${r.how}/${l.how}`);
  refreshDocks([right, left], swapped, S, { settled: true });
  check('② 뒤바뀐 배치도 저장하지 않는다', JSON.stringify([right, left]) === saved);

  // ③ 원래 배치로 돌아옴
  r = where(normal, right);
  l = where(normal, left);
  check('③ 오른쪽 메모는 오른쪽 모니터, 왼쪽 메모는 주 모니터', r.display.id === S && l.display.id === P, `${r.how}/${l.how}`);
  refreshDocks([right, left], normal, P, { settled: true });
  check('③ 깨어난 뒤에도 고른 모니터가 그대로 저장돼 있다', JSON.stringify([right, left]) === saved);

  // 이번 실행 중 번호를 아직 확인하지 못했어도(켜자마자 잠금 해제 등) 같은 결과여야 한다
  session.clear();
  const r0 = where(sOnlyAt0, right, false), l0 = where(sOnlyAt0, left, false);
  check('막 켜진 직후라도 오른쪽 메모는 오른쪽 모니터, 왼쪽 메모는 기다린다',
    r0.display.id === S && isWaiting(l0), `${r0.how}/${l0.how}`);
  check('배치가 흔들리는 동안엔 번호를 확인해 주지 않는다', session.size === 0);
}

{
  // 재부팅으로 번호가 새로 매겨진 경우는 여전히 좌표로 찾고, 번호만 고쳐 적는다
  const { confirmableId } = require('../src/main/displays');
  const right = { displayId: 854308167, displayHint: { ...hintOf(mon(854308167, 1920)), count: 2 } };
  const rebooted = [mon(11, 0), mon(22, 1920)];
  const r = pickDisplay(rebooted, 11, right);
  check('재부팅 뒤 번호가 바뀌어도 좌표로 찾는다', r.display.id === 22 && r.how === 'bounds', r.how);
  check('그때 번호를 확인해 둔다', confirmableId(r, rebooted, right, true) === 22);
  refreshDocks([right], rebooted, 11, { settled: true });
  check('번호만 고치고 고른 자리는 그대로', right.displayId === 22 && right.displayHint.x === 1920, JSON.stringify(right));
}

// ── 모니터를 끄고 켜는 경우 (오른쪽 모니터에 둔 메모) ──
{
  const picked = { displayId: 3987148736, displayHint: { ...hintOf(after[1]), count: 2 } };
  const snap = JSON.stringify(picked);

  // 오른쪽 모니터를 껐다: 윈도우 목록에서 사라지고 주 모니터 한 대만 남는다
  const offList = [mon(1546791665, 0)];
  const off = pickDisplay(offList, 1546791665, picked);
  check('모니터가 꺼지면 주 모니터로 옮기지 않고 기다린다', isWaiting(off), off.how);
  check('같은 모델이 남아 있어도 이름으로 착각하지 않는다', off.how !== 'label', off.how);
  refreshDocks([picked], offList, 1546791665);
  check('꺼져 있는 동안 고른 모니터 정보를 덮어쓰지 않는다', JSON.stringify(picked) === snap, JSON.stringify(picked));

  // 다시 켰다: 같은 id 로 돌아온 경우
  const back = pickDisplay(after, 1546791665, picked);
  check('다시 켜면 원래 모니터로 돌아간다', back.display.id === 3987148736 && !isWaiting(back), back.how);

  // 다시 켰는데 id 가 새로 매겨진 경우
  const renumbered = [mon(1546791665, 0), mon(777, 1920)];
  const back2 = pickDisplay(renumbered, 1546791665, picked);
  check('켜면서 id 가 바뀌어도 원래 모니터로 돌아간다', back2.display.id === 777 && back2.how === 'bounds', back2.how);
  refreshDocks([picked], renumbered, 1546791665);
  check('바뀐 id 로 고쳐 적되 고를 때의 대수는 지킨다',
    picked.displayId === 777 && picked.displayHint.count === 2, JSON.stringify(picked));

  // 켜지는 도중 해상도가 잠깐 다르게 잡힌 경우 (자리는 같다)
  const settling = [mon(1546791665, 0), mon(888, 1920, 'LG FHD', 1280, 720)];
  const mid = pickDisplay(settling, 1546791665, picked);
  check('켜지는 도중 해상도가 달라도 자리로 찾는다', mid.display.id === 888 && mid.how === 'position', mid.how);
}

{
  // 오른쪽 모니터가 꺼진 동안 다른 모니터가 그 자리(x=1920)에 오지 않는 한 기다린다.
  // 주 모니터만 남은 상태에서 '왼쪽 가장자리' 메모도 마찬가지
  const leftDock = { displayId: 3987148736, displayHint: { ...hintOf(after[1]), count: 2 } };
  const r = pickDisplay([mon(1546791665, 0)], 1546791665, leftDock);
  check('같은 모니터의 다른 가장자리 메모도 기다린다', isWaiting(r), r.how);
}

{
  // 단서가 없는 아주 옛 데이터는 어디였는지 몰라 예전처럼 주 모니터에 둔다
  const r = pickDisplay([mon(1546791665, 0)], 1546791665, { displayId: 42 });
  check('단서가 없는 옛 데이터는 숨기지 않고 주 모니터에 둔다', r.how === 'fallback' && !isWaiting(r), r.how);
}

{
  // 주 모니터를 따르는 가장자리는 기다리지 않는다
  const r = pickDisplay([mon(1546791665, 0)], 1546791665, { displayId: null });
  check('주 모니터를 따르는 가장자리는 숨지 않는다', !isWaiting(r), r.how);
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
