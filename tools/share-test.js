/**
 * 메모 주고받기(내보내기/가져오기) 단위 테스트.
 *   node tools/share-test.js
 *
 * electron 없이 순수 로직만 확인한다. 임시 폴더를 쓰므로 실제 메모는 건드리지 않는다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createShare, htmlToText, safeFileName } = require('../src/main/share');

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
check('첨부 참조가 새 이름으로 바뀐다', !!newFile && newFile[1] !== 'abc.docx', newFile && newFile[1]);
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

for (const dir of [sender, receiver]) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
