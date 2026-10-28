/**
 * 업데이트 적용 시각 계산 단위 테스트.
 *   node tools/update-test.js
 */
const {
  isValidTime, nextAt, planOnDownloaded, decideAtTime, describeAt, BUSY_RETRY_MS,
} = require('../src/main/update-schedule');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
};

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);
const fmt = (date) => `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

// ── 시각 형식 ──
check('18:00 은 올바르다', isValidTime('18:00'));
check('9:05 도 올바르다', isValidTime('9:05'));
check('24:00 은 틀리다', !isValidTime('24:00'));
check('12:60 은 틀리다', !isValidTime('12:60'));
check('빈 값은 틀리다', !isValidTime('') && !isValidTime(null));

// ── 다음 적용 시각 ──
const morning = at(2026, 10, 28, 9, 30);
check('아직 안 지난 시각이면 오늘', fmt(nextAt(morning, '18:00')) === '10/28 18:00', fmt(nextAt(morning, '18:00')));
check('이미 지난 시각이면 내일', fmt(nextAt(morning, '08:00')) === '10/29 08:00', fmt(nextAt(morning, '08:00')));
check('바로 지금 시각이면 내일 (지금 당장 재시작하지 않는다)', fmt(nextAt(morning, '09:30')) === '10/29 09:30',
  fmt(nextAt(morning, '09:30')));
check('월말을 넘어가도 날짜가 맞다', fmt(nextAt(at(2026, 10, 31, 23, 0), '07:00')) === '11/1 07:00',
  fmt(nextAt(at(2026, 10, 31, 23, 0), '07:00')));
check('틀린 시각이면 null', nextAt(morning, '25:00') === null);

// ── 다 받았을 때의 계획 ──
const ask = planOnDownloaded({ updateMode: 'ask' }, morning);
check('물어보기: 알리고 시각은 정하지 않는다', ask.notify && ask.applyAt === null, JSON.stringify(ask));

const timed = planOnDownloaded({ updateMode: 'time', updateTime: '18:00' }, morning);
check('정한 시각: 그 시각으로 잡고 알린다', timed.notify && fmt(new Date(timed.applyAt)) === '10/28 18:00',
  fmt(new Date(timed.applyAt)));

const onQuit = planOnDownloaded({ updateMode: 'quit' }, morning);
check('끌 때만: 알리지도 시각을 잡지도 않는다', !onQuit.notify && onQuit.applyAt === null, JSON.stringify(onQuit));

const unknown = planOnDownloaded({ updateMode: '??' }, morning);
check('모르는 값이면 물어보기로', unknown.notify && unknown.applyAt === null);

const badTime = planOnDownloaded({ updateMode: 'time', updateTime: 'xx' }, morning);
check('정한 시각이 틀렸으면 시각 없이 알리기만', badTime.notify && badTime.applyAt === null);

// ── 정한 시각이 됐을 때 ──
const free = decideAtTime(false, morning);
check('메모를 안 쓰고 있으면 적용한다', free.apply && free.retryAt === null);
const busy = decideAtTime(true, morning);
check('메모를 쓰는 중이면 10분 미룬다', !busy.apply && busy.retryAt === morning.getTime() + BUSY_RETRY_MS);

// ── 표시 ──
check('오늘 시각 표시', describeAt(at(2026, 10, 28, 18, 0).getTime(), morning) === '오늘 18:00');
check('내일 시각 표시', describeAt(at(2026, 10, 29, 7, 5).getTime(), morning) === '내일 07:05');

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
