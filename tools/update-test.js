/**
 * 업데이트 적용 시각 계산 단위 테스트.
 *   node tools/update-test.js
 */
const {
  isValidTime, nextAt, planOnDownloaded, decideAtTime, describeAt, BUSY_RETRY_MS,
  checkMode, checkOnLaunch, dueCheck,
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

// ── 언제 새 버전을 확인할지 ──
const H = 60 * 60 * 1000;
const noon = at(2026, 10, 28, 12, 0);
check('기본은 켤 때 한 번', checkMode({}) === 'launch' && checkOnLaunch({}));
check('켤 때 한 번이면 켜져 있는 동안 다시 확인하지 않는다', !dueCheck({ updateCheck: 'launch' }, noon.getTime() - 48 * H, noon));
check('0.6.0 에서 자동 확인을 꺼 둔 사람은 그대로 끔', checkMode({ updateAutoCheck: false }) === 'off');
check('0.6.0 에서 켜 둔 사람은 새 기본값(켤 때 한 번)으로', checkMode({ updateAutoCheck: true }) === 'launch');
check('확인하지 않음이면 켤 때도 안 한다', !checkOnLaunch({ updateCheck: 'off' }) && !dueCheck({ updateCheck: 'off' }, null, noon));

const every4 = { updateCheck: 'interval', updateCheckHours: 4 };
check('간격: 4시간이 지났으면 확인', dueCheck(every4, noon.getTime() - 5 * H, noon));
check('간격: 아직 안 지났으면 기다린다', !dueCheck(every4, noon.getTime() - 1 * H, noon));
check('간격: 켤 때도 확인한다', checkOnLaunch(every4));
check('간격 값이 이상하면 4시간으로', dueCheck({ updateCheck: 'interval', updateCheckHours: 7 }, noon.getTime() - 4 * H, noon)
  && !dueCheck({ updateCheck: 'interval', updateCheckHours: 7 }, noon.getTime() - 3 * H, noon));

const daily9 = { updateCheck: 'daily', updateCheckTime: '09:00' };
check('매일: 그 시각이 지났고 그 뒤로 확인 안 했으면 확인', dueCheck(daily9, at(2026, 10, 28, 8, 0).getTime(), noon));
check('매일: 그 시각 뒤에 이미 확인했으면 안 한다', !dueCheck(daily9, at(2026, 10, 28, 9, 30).getTime(), noon));
check('매일: 아직 그 시각 전이면 기다린다', !dueCheck(daily9, at(2026, 10, 27, 9, 0).getTime(), at(2026, 10, 28, 8, 0)));
check('매일: 절전으로 그 시각을 넘겼어도 깨어나면 확인', dueCheck(daily9, at(2026, 10, 27, 9, 0).getTime(), at(2026, 10, 28, 14, 0)));
check('매일: 시각이 틀렸으면 확인하지 않는다', !dueCheck({ updateCheck: 'daily', updateCheckTime: 'xx' }, null, noon));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
