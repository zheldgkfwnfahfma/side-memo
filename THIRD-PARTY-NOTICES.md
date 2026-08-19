# 제3자 라이선스 고지

'사이드 메모'는 아래 오픈소스를 포함합니다. 빌드한 앱을 다른 사람에게 전달할 때는
이 파일과 Electron 배포본에 들어 있는 `LICENSE`, `LICENSES.chromium.html` 을 함께 두면 됩니다.
(electron-builder 로 패키징하면 두 파일은 자동으로 포함됩니다.)

| 구성요소 | 버전 | 라이선스 | 비고 |
|---|---|---|---|
| Electron | 32.3.3 | MIT | 앱 런타임 |
| Chromium | Electron 32 번들 | BSD-3-Clause 외 | `LICENSES.chromium.html` 에 전체 목록 |
| Node.js | Electron 32 번들 | MIT | |
| FFmpeg (`ffmpeg.dll`) | Electron 32 번들 | LGPL-2.1+ | 동적 라이브러리(DLL)로 링크됨 |

## 이 앱이 직접 쓰는 npm 런타임 의존성

없습니다. `npm ls --omit=dev` 결과가 비어 있습니다.
Electron 은 `devDependencies` 이고, 빌드 시 런타임 바이너리로만 들어갑니다.

## 폰트

폰트 파일을 포함하지 않습니다. 설정의 폰트 목록(맑은 고딕, Pretendard, 나눔고딕 등)은
**이름으로 참조만 하며**, 사용자 PC에 설치된 폰트가 있을 때만 적용됩니다.

## 아이콘

`tools/make-icon.js` 가 코드로 생성합니다. 외부 아이콘 에셋을 쓰지 않습니다.

## 네트워크

앱은 어떤 서버에도 접속하지 않습니다. 메모 안의 링크를 `Ctrl+클릭` 했을 때만
기본 브라우저로 해당 주소를 엽니다. 수집·전송하는 데이터가 없고 모든 내용은
`%APPDATA%\side-memo\` 아래에만 저장됩니다.
