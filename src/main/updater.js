/**
 * 자동 업데이트.
 *
 * 확인하는 곳은 GitHub 의 이 앱 릴리스 주소 하나뿐이다 (package.json 의 build.publish).
 *   <주소>/latest.yml          최신 버전 번호와 설치본의 해시
 *   <주소>/SideMemo-Setup-…exe 새 버전 설치본 (새 버전이 있을 때만)
 * 메모나 사용자를 구분할 정보는 보내지 않는다 (설치마다 붙는 번호도 0 으로 덮는다. 아래 참고).
 *
 * 흐름: 확인 → 새 버전이 있으면 뒤에서 받아 둠 → 다 받으면 설정에 따라
 *   'ask'  알림을 띄우고 사용자가 고른다 (지금 재시작 / 시간 정하기 / 나중에)
 *   'time' 정해 둔 시각에 적용한다
 *   'quit' 앱을 끌 때 적용한다
 * 어느 쪽이든 고르지 않고 지나가면 앱을 끌 때 적용된다.
 */
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const { planOnDownloaded, decideAtTime, shortError } = require('./update-schedule');

const FIRST_CHECK_MS = 30 * 1000;            // 켜자마자는 바쁘니 조금 뒤에
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;   // 그 뒤로는 4시간마다
const CLOCK_TICK_MS = 30 * 1000;             // 정한 시각이 됐는지 보는 주기

/**
 * @param {object} o
 * @param {() => object} o.getSettings
 * @param {() => boolean} o.isBusy          메모를 펼쳐 쓰는 중인지 (정한 시각이어도 미룬다)
 * @param {() => Promise} o.beforeInstall   적용 직전에 모든 창의 메모를 저장한다
 * @param {(state) => void} o.onChange
 * @param {(state) => void} o.onReady       다 받았고 알려야 할 때
 * @param {object} [o.test]                 테스트 전용 { feedUrl, configPath } — 실제로 설치하지 않는다
 */
function createUpdater({ getSettings, isBusy, beforeInstall, onChange, onReady, test = null }) {
  const state = {
    status: 'idle',            // idle | checking | none | downloading | ready | installing | error
    current: app.getVersion(),
    version: null,             // 새 버전
    percent: 0,
    applyAt: null,             // 이 시각(ms)에 적용
    error: null,
    checkedAt: null,
    installRequested: false,   // 테스트에서 '설치했을 것'을 확인하려고
  };

  const set = (patch) => { Object.assign(state, patch); onChange({ ...state }); };

  autoUpdater.autoDownload = true;              // 새 버전이 있으면 뒤에서 받아 둔다
  autoUpdater.autoInstallOnAppQuit = true;      // 고르지 않았으면 끌 때 적용
  autoUpdater.disableDifferentialDownload = true; // 이전 설치본 조각을 찾으러 다른 곳을 뒤지지 않는다
  autoUpdater.logger = null;

  /*
   * electron-updater 는 설치마다 무작위 번호를 만들어 x-user-staging-id 헤더로 보낸다
   * (일부 사용자에게만 먼저 배포하는 기능용). 이 앱은 그 기능을 쓰지 않고, 설치를 서로
   * 구분할 수 있는 값을 보내지 않기로 했으므로 모두 같은 0 값으로 덮어쓴다.
   */
  autoUpdater.requestHeaders = { 'x-user-staging-id': '00000000-0000-0000-0000-000000000000' };

  if (test) {
    // 테스트는 포장되지 않은 앱이라 업데이터가 꺼져 있다. 가짜 서버를 바라보게 켠다.
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = test.configPath;
    autoUpdater.setFeedURL({ provider: 'generic', url: test.feedUrl });
  }

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-not-available', () => set({ status: 'none', checkedAt: Date.now() }));
  autoUpdater.on('update-downloaded', (info) => {
    const plan = planOnDownloaded(getSettings(), new Date());
    set({ status: 'ready', version: info.version, percent: 100, checkedAt: Date.now(), applyAt: plan.applyAt });
    if (plan.notify) onReady({ ...state });
  });
  autoUpdater.on('error', (err) => {
    // 이미 받아 둔 게 있으면 그 상태를 지킨다
    if (state.status === 'ready' || state.status === 'installing') return;
    set({ status: 'error', error: shortError(err), checkedAt: Date.now() });
  });

  async function check({ manual = false } = {}) {
    if (!manual && getSettings().updateAutoCheck === false) return false;
    if (['checking', 'downloading', 'ready', 'installing'].includes(state.status)) return false;
    try {
      await autoUpdater.checkForUpdates();
      return true;
    } catch (err) {
      set({ status: 'error', error: shortError(err), checkedAt: Date.now() });
      return false;
    }
  }

  /** 지금 적용: 메모를 저장하고, 조용히 설치한 뒤 다시 켠다. */
  async function applyNow() {
    if (state.status !== 'ready') return false;
    set({ status: 'installing', applyAt: null });
    try { await beforeInstall(); } catch { /* 저장이 늦어도 설치는 진행한다 (자동 저장이 이미 돌고 있다) */ }
    if (test) { set({ installRequested: true }); return true; }   // 테스트에서는 실제로 설치하지 않는다
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  /** 이 시각에 적용. null 이면 정해진 시각을 지운다 (끌 때 적용). */
  function applyAt(ms) {
    if (state.status !== 'ready') return false;
    set({ applyAt: Number.isFinite(ms) ? ms : null });
    return true;
  }

  /*
   * 정한 시각이 됐는지는 짧은 주기로 시계를 보고 판단한다.
   * 긴 setTimeout 하나로 걸면 PC 가 절전에 들어갔을 때 시각이 어긋난다.
   */
  function tick() {
    if (state.status !== 'ready' || state.applyAt == null) return;
    const now = new Date();
    if (now.getTime() < state.applyAt) return;
    const d = decideAtTime(isBusy(), now);
    if (d.apply) applyNow();
    else set({ applyAt: d.retryAt });   // 메모를 쓰는 중이면 10분 미룬다
  }

  /** 설정의 적용 방식이 바뀌면, 이미 받아 둔 업데이트의 계획도 다시 세운다. */
  function replan() {
    if (state.status !== 'ready') return;
    set({ applyAt: planOnDownloaded(getSettings(), new Date()).applyAt });
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    setTimeout(() => check(), FIRST_CHECK_MS);
    setInterval(() => check(), CHECK_EVERY_MS);
    setInterval(tick, CLOCK_TICK_MS);
  }

  return { state: () => ({ ...state }), check, applyNow, applyAt, replan, tick, start };
}

module.exports = { createUpdater };
