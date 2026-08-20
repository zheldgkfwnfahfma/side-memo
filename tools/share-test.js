/**
 * 메모 주고받기(내보내기/가져오기) 단위 테스트.
 *   node tools/share-test.js
 *
 * electron 없이 순수 로직만 확인한다. 임시 폴더를 쓰므로 실제 메모는 건드리지 않는다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createShare, htmlToText, safeFileName, safeStoredName, uniqueStoredName } = require('../src/main/share');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
};

// '보내는 쪽'과 '받는 쪽' 폴더를 따로 두고 실제로 주고받아 본다
const sender = fs.mkdtempSync(path.join(os.tmpdir(), 'smemo-send-'));
const receiver = fs.mkdtempSync(path.join(os.tmpdir(), 'smemo-recv-'));
for (const dir of [sender, receiver]) {
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
}

let seq = 0;
const mk = (dir) => createShare({
  imageDir: path.join(dir, 'images'),
  fileDir: path.join(dir, 'files'),
  uuid: () => `new-${++seq}`,
});
const out = mk(sender);
const inn = mk(receiver);

// 보내는 쪽에 이미지와 첨부파일을 만들어 둔다
fs.writeFileSync(path.join(sender, 'images', 'pic.png'), Buffer.from('PNGDATA'));
fs.writeFileSync(path.join(sender, 'files', 'abc.docx'), Buffer.from('DOCXDATA'));

const memo = {
  name: '접속 정보',
  color: '#C4B5FD',
  html: '<div><b>서버</b> 10.0.0.5</div>'
      + '<img src="sidememo-img://img/pic.png" style="width:60%">'
      + '<span class="file-chip" contenteditable="false" data-file="abc.docx">📎<span class="fname">규격서.docx</span></span>',
};

// ── 내보내기 ─────────────────────────────────────────────
const bundle = out.toBundle([memo]);
check('묶음에 메모가 담긴다', bundle.memos.length === 1 && bundle.memos[0].name === '접속 정보');
check('이미지가 통째로 담긴다', Buffer.from(bundle.images['pic.png'], 'base64').toString() === 'PNGDATA');
check('첨부파일이 통째로 담긴다', Buffer.from(bundle.files['abc.docx'], 'base64').toString() === 'DOCXDATA');

// ── 받는 쪽에서 가져오기 ──────────────────────────────────
const imported = inn.fromBundle(JSON.parse(JSON.stringify(bundle)));
check('메모가 복원된다', imported.length === 1 && imported[0].name === '접속 정보');
check('글 내용이 그대로다', /10\.0\.0\.5/.test(imported[0].html));

const newImg = imported[0].html.match(/sidememo-img:\/\/img\/([^"]+)/);
const newFile = imported[0].html.match(/data-file="([^"]+)"/);
check('이미지 참조가 새 이름으로 바뀐다', !!newImg && newImg[1] !== 'pic.png', newImg && newImg[1]);
// 첨부파일은 원래 이름을 지킨다. 받는 쪽에서 알아볼 수 있어야 하기 때문.
check('첨부 참조가 원래 이름을 지킨다',
  !!newFile && decodeURIComponent(newFile[1]) === 'abc.docx', newFile && newFile[1]);
check('그 이름의 파일이 실제로 있다',
  fs.existsSync(path.join(receiver, 'files', 'abc.docx')));

// 받는 쪽에 같은 이름이 이미 있으면 덮어쓰지 않고 비켜 간다
{
  const again = inn.fromBundle(JSON.parse(JSON.stringify(bundle)));
  const ref = again[0].html.match(/data-file="([^"]+)"/);
  check('같은 첨부를 또 받으면 이름을 비켜 간다',
    decodeURIComponent(ref[1]) === 'abc (2).docx', ref && decodeURIComponent(ref[1]));
  check('먼저 받은 첨부는 그대로 남는다',
    fs.readFileSync(path.join(receiver, 'files', 'abc.docx'), 'utf8') === 'DOCXDATA');
}
check('이미지 파일이 받는 쪽에 저장된다',
  fs.readFileSync(path.join(receiver, 'images', newImg[1])).toString() === 'PNGDATA');
check('첨부파일이 받는 쪽에 저장된다',
  fs.readFileSync(path.join(receiver, 'files', newFile[1])).toString() === 'DOCXDATA');
check('첨부 확장자가 유지된다', newFile[1].endsWith('.docx'), newFile[1]);

// 보내는 쪽 원본은 그대로여야 한다
check('보내도 원본은 그대로', fs.existsSync(path.join(sender, 'images', 'pic.png')));

// ── 잘못된 파일 ──────────────────────────────────────────
let rejected = false;
try { inn.fromBundle({ hello: 'world' }); } catch { rejected = true; }
check('사이드 메모 파일이 아니면 거부', rejected);

// ── HTML 한 장으로 내보내기 ───────────────────────────────
const html = out.toStandaloneHtml([memo], { bgColor: '#FBF3B0', textColor: '#111827', fontSize: 15 });
check('HTML 에 이미지가 data URI 로 박힌다', html.includes('data:image/png;base64,'), '');
check('HTML 에 앱 전용 주소가 남지 않는다', !html.includes('sidememo-img://'));
check('HTML 에 제목이 들어간다', html.includes('접속 정보'));
check('HTML 에 첨부 이름은 남는다', html.includes('규격서.docx'));
check('HTML 에 첨부 토큰은 빠진다', !html.includes('data-file='));

// ── 텍스트 ───────────────────────────────────────────────
const txt = out.toPlainText([memo]);
check('텍스트에 태그가 안 섞인다', !/[<>]/.test(txt), txt);
check('텍스트에 내용이 남는다', txt.includes('10.0.0.5') && txt.includes('접속 정보'));

const back = inn.fromPlainText('첫 줄\n둘째 줄', '메모장');
check('텍스트를 메모로 되돌린다', back.html.includes('첫 줄') && back.html.includes('둘째 줄'), back.html);
check('텍스트 가져오기는 HTML 을 이스케이프한다',
  inn.fromPlainText('<script>x</script>', 'a').html.includes('&lt;script&gt;'));

// ── 이름 다듬기 ──────────────────────────────────────────
check('파일 이름에서 금지문자 제거', safeFileName('업무/보고:2026') === '업무_보고_2026', safeFileName('업무/보고:2026'));
check('빈 이름은 기본값', safeFileName('') === '메모');
check('htmlToText 가 태그를 걷어낸다', htmlToText('<div>가<br>나</div>') === '가 나', htmlToText('<div>가<br>나</div>'));

// ── 첨부파일 저장 이름 ────────────────────────────────────
const nm = (x) => { const r = safeStoredName(x); return r.stem + r.ext; };

check('원래 이름을 그대로 쓴다', nm('분기보고서.docx') === '분기보고서.docx', nm('분기보고서.docx'));
check('경로가 섞여 와도 이름만 남긴다',
  nm('C:\\Windows\\system32\\cmd.exe') === 'cmd.exe', nm('C:\\Windows\\cmd.exe'));
check('상위 폴더로 못 올라간다', nm('..') === '첨부파일', nm('..'));
check('슬래시 경로도 이름만 남긴다', nm('../../etc/passwd') === 'passwd', nm('../../etc/passwd'));
check('금지문자는 밑줄로 바뀐다', nm('보고서:최종?.txt') === '보고서_최종_.txt', nm('보고서:최종?.txt'));
check('윈도우 장치 이름은 피한다', nm('CON.txt') === '_CON.txt', nm('CON.txt'));
check('끝의 점과 공백은 지운다', nm('메모.txt. ') === '메모.txt', nm('메모.txt. '));
check('점으로 시작하는 이름은 살린다', nm('.gitignore') === '.gitignore', nm('.gitignore'));
check('이름이 없으면 기본값', nm('') === '첨부파일', nm(''));
check('아주 긴 이름은 자른다', Buffer.byteLength(nm('가'.repeat(200) + '.txt'), 'utf8') <= 128,
  String(Buffer.byteLength(nm('가'.repeat(200) + '.txt'), 'utf8')));
check('긴 이름도 확장자는 지킨다', nm('가'.repeat(200) + '.txt').endsWith('.txt'));

// 같은 이름이 이미 있으면 비켜 간다
{
  const dir = path.join(sender, 'files');
  fs.writeFileSync(path.join(dir, '같은이름.txt'), 'A');
  const second = uniqueStoredName(dir, '같은이름.txt');
  check('이름이 겹치면 (2) 를 붙인다', second === '같은이름 (2).txt', second);
  fs.writeFileSync(path.join(dir, second), 'B');
  check('그 다음은 (3)', uniqueStoredName(dir, '같은이름.txt') === '같은이름 (3).txt');
  check('먼저 넣은 파일을 덮어쓰지 않는다',
    fs.readFileSync(path.join(dir, '같은이름.txt'), 'utf8') === 'A');
  fs.unlinkSync(path.join(dir, '같은이름.txt'));
  fs.unlinkSync(path.join(dir, second));
}

// 이름에 & 가 있어도 내보내고 받는 과정에서 어긋나지 않아야 한다
{
  fs.writeFileSync(path.join(sender, 'files', 'A&B 보고서.docx'), Buffer.from('AMPDATA'));
  const tricky = {
    name: '까다로운 이름',
    html: '<span class="file-chip" data-file="' + encodeURIComponent('A&B 보고서.docx') + '">A&amp;B 보고서.docx</span>',
  };
  const bundle = out.toBundle([tricky]);
  check('& 가 든 이름도 묶음에 담긴다', !!bundle.files['A&B 보고서.docx'],
    Object.keys(bundle.files).join(', '));

  const got = inn.fromBundle(bundle);
  check('받는 쪽에도 원래 이름으로 저장된다',
    fs.existsSync(path.join(receiver, 'files', 'A&B 보고서.docx')),
    fs.readdirSync(path.join(receiver, 'files')).join(', '));
  check('메모의 참조도 그 파일을 가리킨다',
    got[0].html.includes('data-file="' + encodeURIComponent('A&B 보고서.docx') + '"'), got[0].html);
}

for (const dir of [sender, receiver]) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
