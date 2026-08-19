const fs = require('fs');
const path = require('path');

/**
 * 메모를 파일로 주고받기 위한 변환들.
 * 전자 메일이나 메신저로 파일 하나만 건네면 되도록, 이미지와 첨부파일까지 함께 담는다.
 *
 * electron 에 기대지 않는 순수 로직이라 따로 테스트할 수 있다.
 */
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

function safeFileName(name) {
  return String(name || '메모').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || '메모';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 메모 HTML 에서 사람이 읽는 글자만 뽑는다. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(div|p|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 메모가 참조하는 이미지·첨부파일 이름을 뽑는다. */
function referencedAssets(html) {
  const images = [...String(html || '').matchAll(/sidememo-img:\/\/img\/([^"'\s)]+)/g)]
    .map((m) => decodeURIComponent(m[1]));
  const files = [...String(html || '').matchAll(/data-file="([^"]+)"/g)]
    .map((m) => decodeURIComponent(m[1]));
  return { images: [...new Set(images)], files: [...new Set(files)] };
}

/**
 * @param {object} deps
 * @param {string} deps.imageDir  이미지 폴더
 * @param {string} deps.fileDir   첨부파일 폴더
 * @param {function} deps.uuid    새 파일 이름 생성기
 */
function createShare({ imageDir, fileDir, uuid }) {
  /** 메모들을 이미지·첨부까지 담은 묶음 하나로 만든다. */
  function toBundle(tabs) {
    const images = {};
    const files = {};

    for (const tab of tabs) {
      const used = referencedAssets(tab.html);
      for (const name of used.images) {
        if (images[name]) continue;
        const p = path.join(imageDir, path.basename(name));
        if (fs.existsSync(p)) images[name] = fs.readFileSync(p).toString('base64');
      }
      for (const token of used.files) {
        if (files[token]) continue;
        const p = path.join(fileDir, path.basename(token));
        if (fs.existsSync(p)) files[token] = fs.readFileSync(p).toString('base64');
      }
    }

    return {
      app: 'side-memo',
      format: 1,
      exportedAt: new Date().toISOString(),
      memos: tabs.map((t) => ({ name: t.name, color: t.color, html: t.html || '' })),
      images,
      files,
    };
  }

  /** 받은 묶음을 풀어 이 PC에 저장하고, 새 이름으로 바꿔 끼운다. */
  function fromBundle(bundle) {
    if (!bundle || bundle.app !== 'side-memo' || !Array.isArray(bundle.memos)) {
      throw new Error('사이드 메모 파일이 아닙니다');
    }

    const imageMap = {};
    for (const [name, b64] of Object.entries(bundle.images || {})) {
      const fresh = `${uuid()}${path.extname(name) || '.png'}`;
      fs.writeFileSync(path.join(imageDir, fresh), Buffer.from(b64, 'base64'));
      imageMap[name] = fresh;
    }

    const fileMap = {};
    for (const [token, b64] of Object.entries(bundle.files || {})) {
      const fresh = `${uuid()}${path.extname(token)}`;
      fs.writeFileSync(path.join(fileDir, fresh), Buffer.from(b64, 'base64'));
      fileMap[token] = fresh;
    }

    return bundle.memos.map((m) => {
      let html = String(m.html || '');
      for (const [oldName, fresh] of Object.entries(imageMap)) {
        html = html.split(`sidememo-img://img/${oldName}`).join(`sidememo-img://img/${fresh}`);
      }
      for (const [oldToken, fresh] of Object.entries(fileMap)) {
        html = html.split(`data-file="${oldToken}"`).join(`data-file="${fresh}"`);
      }
      return { name: String(m.name || '가져온 메모').slice(0, 20), color: m.color || null, html };
    });
  }

  /** 앱이 없어도 브라우저로 볼 수 있는 HTML 한 장. 이미지는 파일 안에 박아 넣는다. */
  function toStandaloneHtml(tabs, settings) {
    const body = tabs.map((tab) => {
      let html = String(tab.html || '');

      for (const name of referencedAssets(html).images) {
        const p = path.join(imageDir, path.basename(name));
        if (!fs.existsSync(p)) continue;
        const mime = MIME[path.extname(name).toLowerCase()] || 'image/png';
        const uri = `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
        html = html.split(`sidememo-img://img/${name}`).join(uri);
      }
      // 첨부파일은 HTML 한 장에 담을 수 없으므로 이름만 남긴다
      html = html.replace(/ data-file="[^"]*"/g, '');

      return `<section><h2>${escapeHtml(tab.name)}</h2>${html}</section>`;
    }).join('\n');

    const s = settings || {};
    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>${escapeHtml(tabs.length === 1 ? tabs[0].name : '사이드 메모')}</title>
<style>
  body { margin: 0; padding: 32px; background: ${s.bgColor || '#FBF3B0'}; color: ${s.textColor || '#4C1D95'};
         font-family: '${s.fontFamily || 'Malgun Gothic'}', 'Malgun Gothic', sans-serif;
         font-size: ${s.fontSize || 15}px; line-height: 1.65; }
  section { max-width: 720px; margin: 0 auto 40px; }
  h2 { font-size: 1.3em; margin: 0 0 12px; }
  img { max-width: 100%; border-radius: 10px; }
  .file-chip { display: inline-flex; gap: 5px; padding: 3px 9px; border-radius: 999px;
               background: rgba(0,0,0,.08); font-size: .9em; }
  footer { max-width: 720px; margin: 0 auto; opacity: .5; font-size: 12px; }
</style></head>
<body>
${body}
<footer>사이드 메모에서 내보냄 · ${new Date().toLocaleString('ko-KR')}</footer>
</body></html>`;
  }

  /** 메모들을 순수 텍스트로. */
  function toPlainText(tabs) {
    return tabs.map((t) => `[${t.name}]\n${htmlToText(t.html)}`).join('\n\n');
  }

  /** 텍스트 파일을 메모 하나로. */
  function fromPlainText(text, name) {
    return {
      name: String(name || '가져온 메모').slice(0, 20),
      color: null,
      html: String(text).split('\n').map((line) => `<div>${escapeHtml(line) || '<br>'}</div>`).join(''),
    };
  }

  return { toBundle, fromBundle, toStandaloneHtml, toPlainText, fromPlainText };
}

module.exports = { createShare, htmlToText, referencedAssets, safeFileName, escapeHtml };
