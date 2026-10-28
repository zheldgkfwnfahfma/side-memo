/**
 * 업데이트를 '언제' 적용할지 계산한다.
 * electron 에 기대지 않는 순수 로직이라 따로 테스트할 수 있다.
 *
 * 적용 방식 (설정의 updateMode)
 *   'ask'  : 받으면 알려 주고 사용자가 고른다 (지금 / 시간 정하기 / 나중에)
 *   'time' : 받으면 정해 둔 시각(updateTime, 'HH:MM')에 알아서 적용한다
 *   'quit' : 앱을 끌 때만 적용한다
 */

const MODES = ['ask', 'time', 'quit'];
const BUSY_RETRY_MS = 10 * 60 * 1000;   // 메모를 쓰고 있으면 10분 뒤 다시 본다

/** 'HH:MM' 이 올바른지. */
function isValidTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
}

/**
 * now 이후로 처음 돌아오는 hh:mm 시각 (오늘 지났으면 내일).
 * @param {Date} now
 * @param {string} hhmm
 * @returns {Date|null}
 */
function nextAt(now, hhmm) {
  if (!isValidTime(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const at = new Date(now.getTime());
  at.setHours(h, m, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * 업데이트를 다 받았을 때 언제 적용할지.
 * @returns {{ applyAt: number|null, notify: boolean }}
 *   applyAt: 그 시각(ms)에 적용. null 이면 정해진 시각이 없다 (물어보기·끌 때만)
 *   notify : 받았다고 알림을 띄울지
 */
function planOnDownloaded(settings, now) {
  const mode = MODES.includes(settings.updateMode) ? settings.updateMode : 'ask';
  if (mode === 'time') {
    const at = nextAt(now, settings.updateTime);
    return { applyAt: at ? at.getTime() : null, notify: true };
  }
  if (mode === 'quit') return { applyAt: null, notify: false };
  return { applyAt: null, notify: true };
}

/**
 * 정해진 시각이 됐을 때 지금 적용해도 되는지.
 * 메모를 펼쳐 놓고 쓰는 중이면 끊지 않고 미룬다.
 * @returns {{ apply: boolean, retryAt: number|null }}
 */
function decideAtTime(busy, now) {
  if (busy) return { apply: false, retryAt: now.getTime() + BUSY_RETRY_MS };
  return { apply: true, retryAt: null };
}

/** 사람이 읽는 'HH:MM' (오늘이 아니면 '내일 HH:MM'). */
function describeAt(ms, now) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay) return `오늘 ${hm}`;
  if (d.toDateString() === tomorrow.toDateString()) return `내일 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 사람이 읽을 짧은 오류. 인터넷이 안 되거나 회사망에서 막힌 경우가 대부분이다. */
function shortError(err) {
  const msg = String((err && err.message) || err || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::|getaddrinfo|ERR_INTERNET/i.test(msg)) {
    return '인터넷에 연결할 수 없습니다';
  }
  if (/404|Cannot find channel/i.test(msg)) return '업데이트 정보를 찾지 못했습니다';
  return '확인하지 못했습니다';
}

/*
 * ─── 언제 새 버전을 확인할지 (설정의 updateCheck) ───
 *   'launch'   : 켤 때 한 번 (기본)
 *   'interval' : 켤 때 + 정해 둔 간격(updateCheckHours)마다
 *   'daily'    : 켤 때 + 매일 정한 시각(updateCheckTime)에
 *   'off'      : 자동으로 확인하지 않는다 ('지금 확인' 버튼으로만)
 */
const CHECK_MODES = ['launch', 'interval', 'daily', 'off'];
const CHECK_HOURS = [1, 2, 4, 8, 12, 24];

/** 확인 방식. 0.6.0 의 켜기/끄기(updateAutoCheck)에서 넘어온 설정도 읽는다. */
function checkMode(settings) {
  if (CHECK_MODES.includes(settings.updateCheck)) return settings.updateCheck;
  if (settings.updateAutoCheck === false) return 'off';
  return 'launch';
}

/** 켤 때 확인할지. */
function checkOnLaunch(settings) {
  return checkMode(settings) !== 'off';
}

/**
 * 켜져 있는 동안 지금 다시 확인할 때인지.
 * @param {number|null} lastAt 마지막으로 확인을 마친 시각(ms). 켤 때 확인도 포함한다
 */
function dueCheck(settings, lastAt, now) {
  const mode = checkMode(settings);
  if (mode === 'interval') {
    const h = CHECK_HOURS.includes(Number(settings.updateCheckHours)) ? Number(settings.updateCheckHours) : 4;
    return lastAt == null || now.getTime() - lastAt >= h * 60 * 60 * 1000;
  }
  if (mode === 'daily') {
    if (!isValidTime(settings.updateCheckTime)) return false;
    const [hh, mm] = settings.updateCheckTime.split(':').map(Number);
    const todayAt = new Date(now.getTime());
    todayAt.setHours(hh, mm, 0, 0);
    // 오늘 그 시각이 지났고, 그 뒤로 아직 확인하지 않았으면 (절전으로 그 시각을 넘겼어도 깨어나면 확인)
    return now.getTime() >= todayAt.getTime() && (lastAt == null || lastAt < todayAt.getTime());
  }
  return false;   // 'launch' 는 켤 때만, 'off' 는 하지 않는다
}

module.exports = {
  CHECK_MODES, CHECK_HOURS, checkMode, checkOnLaunch, dueCheck,
  shortError, MODES, BUSY_RETRY_MS, isValidTime, nextAt, planOnDownloaded, decideAtTime, describeAt };
