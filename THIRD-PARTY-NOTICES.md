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

자동 업데이트를 위해 `electron-updater` 와 그 의존성이 설치본에 들어갑니다.
모두 상업적 사용이 가능한 허용형 라이선스이며, 각 패키지의 라이선스 전문은 설치본 안
(`resources/app.asar` 의 `node_modules/<패키지>/LICENSE`)에 그대로 들어 있습니다.

| 패키지 | 버전 | 라이선스 |
|---|---|---|
| electron-updater | 6.8.11 | MIT |
| builder-util-runtime | 9.7.0 | MIT |
| debug | 4.4.3 | MIT |
| ms | 2.1.3 | MIT |
| fs-extra | 10.1.0 | MIT |
| graceful-fs | 4.2.11 | ISC |
| jsonfile | 6.2.1 | MIT |
| universalify | 2.0.1 | MIT |
| js-yaml | 4.3.1 | MIT |
| argparse | 2.0.1 | Python-2.0 (PSF) |
| lazy-val | 1.0.5 | MIT |
| lodash.escaperegexp | 4.1.2 | MIT |
| lodash.isequal | 4.5.0 | MIT |
| sax | 1.6.1 | BlueOak-1.0.0 |
| semver | 7.7.4 | ISC |
| tiny-typed-emitter | 2.1.0 | MIT |

목록은 `npm ls --omit=dev --all` 기준입니다.
Electron 은 `devDependencies` 이고, 빌드 시 런타임 바이너리로만 들어갑니다.

## 폰트

폰트 파일을 포함하지 않습니다. 설정의 폰트 목록(맑은 고딕, Pretendard, 나눔고딕 등)은
**이름으로 참조만 하며**, 사용자 PC에 설치된 폰트가 있을 때만 적용됩니다.

## 아이콘

`tools/make-icon.js` 가 코드로 생성합니다. 외부 아이콘 에셋을 쓰지 않습니다.

## 네트워크

앱이 스스로 접속하는 곳은 **업데이트 확인** 하나뿐입니다. 기본은 앱을 켤 때 한 번이며,
설정에서 간격·시각을 정하거나 끌 수 있습니다.

- `https://github.com/zheldgkfwnfahfma/side-memo/releases/latest/download/latest.yml` — 최신 버전 번호
- 새 버전이 있을 때만 같은 경로의 `SideMemo-Setup-<버전>.exe` — 설치본
- GitHub 는 이 두 요청을 자기 파일 저장소(`release-assets.githubusercontent.com`)로 넘겨 줍니다

요청에 담기는 것은 `User-Agent: electron-builder` 같은 고정 값뿐입니다.
업데이트 도구가 설치마다 붙이는 번호(`x-user-staging-id`)는 모든 설치에서 같은 0 값으로 덮어써서,
요청만으로 설치를 서로 구분할 수 없습니다. 메모 내용은 보내지 않습니다.

그 밖에는 메모 안의 링크를 `Ctrl+클릭` 했을 때 기본 브라우저로 그 주소를 여는 것뿐입니다.
모든 메모는 `%APPDATA%\side-memo\` (또는 설정에서 고른 저장 위치) 아래에만 저장됩니다.
