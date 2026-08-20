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

if (tmp) {
  const from = path.join(tmp, 'dist');
  if (fs.existsSync(from)) {
    fs.mkdirSync(DIST, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const src = path.join(from, name);
      // 설치본만 가져온다. 부산물(blockmap, 디버그 로그)은 배포할 필요가 없다.
      if (fs.statSync(src).isFile() && name.endsWith('.exe')) {
        fs.copyFileSync(src, path.join(DIST, name));
      }
    }
    console.log(`\n결과물을 옮겼습니다 → ${DIST}`);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 임시 폴더 */ }
}

if (!ok) {
  console.error('\n빌드 실패');
  process.exit(1);
}

console.log('\n완성된 파일:');
for (const name of fs.readdirSync(DIST)) {
  const st = fs.statSync(path.join(DIST, name));
  if (st.isFile()) console.log(`  ${name}  (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
}
