/**
 * 설치본 만들기.
 *   npm run build
 *
 * 이 프로젝트 경로에 한글이 들어 있으면(만들기) electron-builder 가 종종 실패한다.
 * 그래서 한글 경로일 때는 임시 ASCII 폴더에 소스를 복사해서 빌드하고 결과만 가져온다.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const hasNonAscii = /[^\x20-\x7E]/.test(ROOT);

function run(cmd, args, cwd) {
  console.log(`\n> ${cmd} ${args.join(' ')}\n  (${cwd})`);
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: true });
  return res.status === 0;
}

// 아이콘부터 새로 만든다
require('./make-icon.js');

// 지난 빌드 결과가 섞이지 않도록 비우고 시작한다.
// 폴더째 지우는 건 탐색기 등이 잡고 있으면 실패하므로, 안 되면 파일만 지운다.
try {
  fs.rmSync(DIST, { recursive: true, force: true, maxRetries: 3 });
} catch {
  for (const name of fs.existsSync(DIST) ? fs.readdirSync(DIST) : []) {
    try { fs.rmSync(path.join(DIST, name), { recursive: true, force: true }); } catch { /* 잠긴 파일 */ }
  }
}

let buildDir = ROOT;
let tmp = null;

if (hasNonAscii) {
  // NSIS 는 경로가 길거나 8.3 단축이름(ADMINI~1)이 섞이면 출력 파일을 못 여는 경우가 있다.
  // 드라이브 바로 아래 짧은 폴더를 쓰고, 못 만들면 임시 폴더로 물러난다.
  const short = path.join(path.parse(ROOT).root, 'sidememo-build');
  try {
    // 폴더가 지워지지 않더라도(잠김 등) 지난 dist 만큼은 반드시 비운다
    fs.rmSync(path.join(short, 'dist'), { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(short, { recursive: true, force: true, maxRetries: 3 });
    fs.mkdirSync(short, { recursive: true });
    tmp = short;
  } catch {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidememo-build-'));
  }
  buildDir = tmp;
  console.log(`\n경로에 한글이 있어 임시 폴더에서 빌드합니다:\n  ${tmp}`);

  for (const name of ['src', 'assets', 'package.json', 'README.md', 'THIRD-PARTY-NOTICES.md']) {
    const src = path.join(ROOT, name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, name), { recursive: true });
  }
  // node_modules 를 통째로 복사하면 오래 걸린다. electron 과 builder 만 있으면 된다.
  console.log('의존성 설치 중… (몇 분 걸릴 수 있습니다)');
  if (!run('npm', ['install', '--no-audit', '--no-fund'], tmp)) {
    console.error('의존성 설치 실패');
    process.exit(1);
  }
}

/*
 * --publish never 를 꼭 준다.
 * 이게 없으면 electron-builder 가 git 태그를 보고 "릴리스하라는 뜻"으로 넘겨짚어
 * 스스로 GitHub 에 올리려 하고, 토큰이 없다며 빌드를 실패로 끝낸다.
 * 올리는 일은 우리가 따로 한다(로컬은 손으로, CI 는 gh release 로).
 */
const ok = run('npx', ['electron-builder', '--win', '--x64', '--publish', 'never'], buildDir);

/*
 * 가져올 파일 이름을 정확히 짚는다.
 * '.exe 로 끝나면 전부'로 두면 SideMemo-Setup-x.y.z.__uninstaller.exe(제거 프로그램)까지
 * 딸려온다. 빌드가 중간에 죽으면 그게 dist 에 남아 설치본인 척하게 된다.
 */
const SETUP = `SideMemo-Setup-${require('../package.json').version}.exe`;

// 빌드가 실패했으면 아무것도 가져오지 않는다. 반쪽짜리 결과물이 남는 게 제일 위험하다.
if (ok && tmp) {
  const src = path.join(tmp, 'dist', SETUP);
  if (fs.existsSync(src)) {
    fs.mkdirSync(DIST, { recursive: true });
    fs.copyFileSync(src, path.join(DIST, SETUP));
    console.log(`\n결과물을 옮겼습니다 → ${DIST}`);
  }
}
if (tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 임시 폴더 */ }
}

if (!ok) {
  console.error('\n빌드 실패');
  process.exit(1);
}

/*
 * 크기를 확인한다. Electron 앱이라 정상이면 70MB 를 넘는다.
 * 몇백 KB 짜리가 나왔다면 껍데기만 만들어진 것이므로 배포하지 않도록 여기서 끊는다.
 */
const setupPath = path.join(DIST, SETUP);
if (!fs.existsSync(setupPath)) {
  console.error(`\n${SETUP} 이 만들어지지 않았습니다`);
  process.exit(1);
}
const sizeMB = fs.statSync(setupPath).size / 1024 / 1024;
if (sizeMB < 30) {
  console.error(`\n설치본이 너무 작습니다 (${sizeMB.toFixed(1)} MB). 빌드가 온전히 끝나지 않았습니다.`);
  process.exit(1);
}

console.log('\n완성된 파일:');
for (const name of fs.readdirSync(DIST)) {
  const st = fs.statSync(path.join(DIST, name));
  if (st.isFile()) console.log(`  ${name}  (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
}
