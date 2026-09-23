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
 * electron 에 기대지 않는 순수 로직이라 따로 테스트할 수 있다.
 */

/** 모니터를 다시 찾을 때 쓸 단서. */
function hintOf(display) {
  const b = display.bounds;
  return { x: b.x, y: b.y, width: b.width, height: b.height, label: display.label || '' };
}

/**
 * @param {object[]} displays  screen.getAllDisplays()
 * @param {number}   primaryId screen.getPrimaryDisplay().id
 * @param {object}   dock      { displayId, displayHint }
 * @returns {{ display: object, how: string }}
 *   how: 'primary'  — 주 모니터를 따라가는 가장자리
 *        'bounds'   — 같은 자리·같은 크기 (가장 확실)
 *        'id'       — id 가 그대로
 *        'position' — 자리는 같고 해상도만 바뀜
 *        'label'    — 이름이 하나뿐이라 이름으로
 *        'fallback' — 못 찾아서 일단 주 모니터
 */
function pickDisplay(displays, primaryId, dock) {
  const primary = displays.find((d) => d.id === primaryId) || displays[0];
  if (!dock || dock.displayId == null) return { display: primary, how: 'primary' };

  const h = dock.displayHint;
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

    const byLabel = h.label ? displays.filter((d) => d.label === h.label) : [];
    if (byLabel.length === 1) return { display: byLabel[0], how: 'label' };
  }

  // 못 찾았다. 켜지는 중이라 아직 안 잡힌 모니터일 수 있으니 저장값은 건드리지 않는다.
  return { display: primary, how: 'fallback' };
}

/*
 * 이렇게 찾았을 때만 저장값을 고쳐 적는다.
 * 이름이나 자리만으로 찾은 건 '일단 둘 곳'일 뿐이다. 윈도우와 함께 켜질 때는
 * 모니터가 한 대만 먼저 잡히는 순간이 있는데, 같은 모델이라 이름이 같으면
 * 그 한 대를 '이름으로 찾았다'고 착각한다. 그걸 저장해 버리면 1초 뒤 두 번째
 * 모니터가 잡혀도 사용자의 선택은 이미 사라진 뒤다.
 */
const TRUSTED = new Set(['bounds', 'id']);

/**
 * 가장자리들의 모니터 정보를 지금 화면에 맞춰 고쳐 적는다.
 *  - 좌표로 다시 찾았으면 바뀐 id 로 갱신
 *  - id 로 찾았는데 단서가 없던 옛 데이터면 단서를 채움 (다음 재부팅부터 안전)
 *  - 그 밖에는 손대지 않는다
 * @returns {boolean} 바뀐 게 있으면 true (저장이 필요하다)
 */
function refreshDocks(docks, displays, primaryId) {
  let changed = false;
  for (const dock of docks) {
    const { display, how } = pickDisplay(displays, primaryId, dock);
    if (!TRUSTED.has(how)) continue;
    const hint = hintOf(display);
    if (dock.displayId !== display.id || JSON.stringify(dock.displayHint) !== JSON.stringify(hint)) {
      dock.displayId = display.id;
      dock.displayHint = hint;
      changed = true;
    }
  }
  return changed;
}

module.exports = { pickDisplay, hintOf, refreshDocks };
