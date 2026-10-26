/**
 * 가장자리(dock)가 붙을 모니터를 다시 찾는다.
 *
 * 윈도우는 재부팅하거나 그래픽 드라이버가 다시 올라오면 모니터 id 를 새로 매기곤 한다.
 * id 만 저장해 두면 '지정한 모니터를 못 찾음 → 주 모니터로' 가 되어 엉뚱한 화면에 뜬다.
 * 그래서 모니터를 고를 때 화면 좌표(책상 위 배치)를 단서(displayHint)로 같이 남기고,
 * 다시 찾을 때 그걸 먼저 본다.
 *
 * 같은 모델 모니터 두 대면 이름(label)까지 똑같으므로 이름만으로는 가릴 수 없다.
 *
 * 잠금·절전에서 깨어나는 몇 초 동안 윈도우는 배치를 잠깐 이상하게 보고한다.
 * 주 모니터가 늦게 켜지면 오른쪽 모니터 혼자 x=0 에 잡히는 식이다. 그 순간의 좌표를 믿거나
 * 그걸 저장해 버리면, 깨어난 뒤 메모가 엉뚱한 모니터에 붙는다(실제로 겪었다).
 * 그래서
 *   - 모니터가 고를 때보다 적게 잡혀 있으면 좌표·이름으로는 고르지 않는다 (번호가 맞을 때만)
 *   - 이번 실행 중 확인된 번호가 있으면 그걸 먼저 믿는다 (배치는 흔들려도 번호는 그대로다)
 *   - 사용자가 고른 단서는 앱이 고쳐 쓰지 않는다
 *
 * electron 에 기대지 않는 순수 로직이라 따로 테스트할 수 있다.
 */

/** 모니터를 다시 찾을 때 쓸 단서. */
function hintOf(display) {
  const b = display.bounds;
  return { x: b.x, y: b.y, width: b.width, height: b.height, label: display.label || '' };
}

/** 고를 때보다 모니터가 적게 잡혀 있는지 (하나가 꺼졌거나 아직 덜 깨어났다). */
function incomplete(displays, hint) {
  return !!hint && hint.count != null && displays.length < hint.count;
}

/**
 * @param {object[]} displays  screen.getAllDisplays()
 * @param {number}   primaryId screen.getPrimaryDisplay().id
 * @param {object}   dock      { displayId, displayHint }
 * @param {object}   [opts]
 * @param {number}   [opts.sessionId] 이번 실행 중 '이 모니터'라고 확인된 id
 * @param {boolean}  [opts.settled]   모니터 배치가 한동안 바뀌지 않았는지
 * @returns {{ display: object, how: string }}
 *   how: 'primary'  — 주 모니터를 따라가는 가장자리
 *        'session'  — 이번 실행 중 확인된 번호 그대로
 *        'bounds'   — 같은 자리·같은 크기
 *        'id'       — 저장된 id 그대로
 *        'position' — 자리는 같고 해상도만 바뀜
 *        'label'    — 이름이 하나뿐이라 이름으로 (꺼진 모니터가 없을 때만)
 *        'missing'  — 고른 모니터가 꺼져 있다. 다른 모니터로 옮기지 말고 기다린다
 *        'fallback' — 단서도 없는 옛 데이터라 어디인지 몰라서 일단 주 모니터
 */
function pickDisplay(displays, primaryId, dock, { sessionId = null, settled = true } = {}) {
  const primary = displays.find((d) => d.id === primaryId) || displays[0];
  if (!dock || dock.displayId == null) return { display: primary, how: 'primary' };

  const h = dock.displayHint;
  const missing = { display: primary, how: 'missing' };

  // ① 이번 실행 중 확인된 번호. 깨어나는 동안 배치는 흔들려도 번호는 그대로다.
  if (sessionId != null) {
    const s = displays.find((d) => d.id === sessionId);
    if (s) return { display: s, how: 'session' };
    // 확인된 모니터가 목록에 없다. 꺼졌거나, 드물게 번호가 새로 매겨졌다.
    // 모니터가 다 돌아오고 배치가 가라앉기 전에는 좌표로 다른 모니터를 고르지 않는다.
    if (h && (!settled || incomplete(displays, h))) return missing;
  }

  // ② 모니터가 고를 때보다 적게 잡혀 있으면 배치가 어긋나 있다. 저장된 번호가 맞을 때만 쓴다.
  if (incomplete(displays, h)) {
    const byId = displays.find((d) => d.id === dock.displayId);
    return byId ? { display: byId, how: 'id' } : missing;
  }

  // ③ 모니터가 다 있다. 좌표 → 번호 → 자리 → 이름 순으로 찾는다.
  const samePlace = (d) => !!h && d.bounds.x === h.x && d.bounds.y === h.y;

  if (h) {
    const same = displays.find((d) => samePlace(d)
      && d.bounds.width === h.width && d.bounds.height === h.height);
    if (same) return { display: same, how: 'bounds' };
  }

  const byId = displays.find((d) => d.id === dock.displayId);
  if (byId) return { display: byId, how: 'id' };

  if (h) {
    const samePos = displays.find(samePlace);
    if (samePos) return { display: samePos, how: 'position' };

    // 이름으로 찾는 건 고를 때 몇 대였는지 알고, 그만큼 다 있을 때만 한다.
    const byLabel = h.label && h.count != null ? displays.filter((d) => d.label === h.label) : [];
    if (byLabel.length === 1) return { display: byLabel[0], how: 'label' };

    // 고른 모니터가 꺼져 있다. 주 모니터로 옮겨 붙이지 않고 돌아올 때까지 기다린다.
    return missing;
  }

  // 단서가 없는 옛 데이터인데 id 도 없다. 어디였는지 알 길이 없어 일단 주 모니터에 둔다.
  return { display: primary, how: 'fallback' };
}

/** 고른 모니터가 꺼져 있어 숨어서 기다려야 하는지. */
function isWaiting(result) {
  return result.how === 'missing';
}

/**
 * 이번 실행 중 '이 모니터'라고 믿어도 되는 번호. 없으면 null.
 * 배치가 가라앉았고, 모니터가 다 있고, 좌표까지 맞을 때만 확인해 준다.
 */
function confirmableId(result, displays, dock, settled) {
  if (!settled || !dock || incomplete(displays, dock.displayHint)) return null;
  if (result.how === 'session' || result.how === 'bounds') return result.display.id;
  return null;
}

/**
 * 저장된 모니터 정보를 지금 화면에 맞춰 고친다. 고치는 건 딱 두 가지뿐이다.
 *  - 재부팅으로 번호가 새로 매겨진 경우(저장된 번호가 목록에 없을 때): 좌표가 정확히 맞으면
 *    바뀐 번호로 갱신 (단서는 그대로)
 *  - 단서가 없던 아주 옛 데이터: 번호로 찾았으면 단서를 채운다
 * 어느 쪽이든 배치가 가라앉았고 모니터가 다 있을 때만 한다.
 *
 * 사용자가 고른 단서(어느 자리의 모니터인지)는 앱이 고쳐 쓰지 않는다.
 * 예전에는 '찾았다' 싶으면 단서까지 고쳐 써서, 깨어나는 도중의 이상한 배치가 저장돼 버렸다.
 *
 * @returns {boolean} 바뀐 게 있으면 true (저장이 필요하다)
 */
function refreshDocks(docks, displays, primaryId, { settled = true } = {}) {
  if (!settled) return false;
  let changed = false;
  for (const dock of docks) {
    if (dock.displayId == null || incomplete(displays, dock.displayHint)) continue;
    const { display, how } = pickDisplay(displays, primaryId, dock);
    // 저장된 번호가 목록에 그대로 있으면 번호는 바뀌지 않은 것이다. 좌표가 다른 모니터와
    // 맞는 건 깨어나는 도중 배치가 잠깐 뒤바뀐 탓이니 고쳐 적지 않는다.
    const renumbered = !displays.some((d) => d.id === dock.displayId);
    if (how === 'bounds' && renumbered && dock.displayId !== display.id) {
      dock.displayId = display.id;
      changed = true;
    } else if (how === 'id' && !dock.displayHint) {
      dock.displayHint = { ...hintOf(display), count: displays.length };
      changed = true;
    }
  }
  return changed;
}

module.exports = { pickDisplay, hintOf, refreshDocks, isWaiting, confirmableId };
