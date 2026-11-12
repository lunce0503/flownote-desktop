# Flownote Windows

Windows 10/11 x64의 Electron 설치 앱. 기존 웹 기능·편집기·cloud API를 공유하며 인터넷 연결이 필요하다. Android와 같은 계정으로 자료를 동기화한다. PC에서 앱 서버나 DB를 실행하지 않는다.

## 개발과 검증

Node.js 24 이상을 사용한다.

```bash
npm ci
npm run check
npm run icons
npm run start:staging
```

Production은 `npm start`, staging은 `--staging` 인자를 사용한다. 임의 URL 환경 변수나 loopback fallback은 제공하지 않는다. Production과 staging은 별도 userData 디렉터리(`Flownote`, `Flownote-Staging`)를 사용한다.

## Windows 릴리즈

```bash
npm run package:win
npm run smoke -- <설치한-Flownote.exe-경로>
```

`release/`에 NSIS 설치기, portable ZIP, SHA256SUMS를 만든다. Windows 설치기는 사용자 영역 설치이며 관리자 권한 상승을 요구하지 않는다. `--staging`은 동일 패키지를 실제 cloud staging에서 검증하는 고정 프로필이다.

`.github/workflows/windows-app.yml`은 Windows runner에서 설치 및 portable 실행, sandbox·로그인·세션·캔버스 저장/재조회·파일 내보내기를 확인한다. `windows-v<version>` 태그는 같은 job에서 검증한 정확한 파일을 GitHub Release로 공개한다. 게시자 코드서명 인증서가 없어 최초 버전은 unsigned로 배포한다. 검사에서 다운로드한 사용자 자료·세션은 artifact에 넣지 않는다.

앱 전용 UI와 설치 안내는 `node scripts/deploy-cloud.mjs release web`으로 staging-first 배포한다. 네이티브 바이너리는 GitHub Release, 설치 안내는 `/windows.html`에서 제공한다.

## 자동 업데이트 배포

앱 버전은 `package.json`에서 관리한다. 1.1.1에서 수정한 Electron net.fetch redirect 대응을 유지하며, 공유 웹에서 오프라인 스냅샷·재동기화·충돌 복구를 제공한다. `updater.cjs`는 별도 RSA 서명된 고정 HTTPS feed를 검증해 설치형 EXE/portable ZIP을 자동 다운로드한다. 자동 설치나 portable 자동 교체는 하지 않는다. 상세 동작은 [소유 사양](https://github.com/lunce0503/flownote-platform/blob/main/docs/product-specs/windows-app.md#120-자동-업데이트)을 따른다.

Windows runner에서 검증한 artifact를 공개한 뒤 `scripts/sign-app-update.mjs`로 staging/production feed를 만든다. `FLOWNOTE_UPDATE_SIGNING_KEY`는 앱에 고정한 공개키와 짝인 저장소 밖 PEM 경로다. 개인키를 Actions artifact/소스/보고서에 넣지 않는다.

```bash
node scripts/sign-app-update.mjs windows staging 1.2.0 <verified-artifact-directory>
node scripts/sign-app-update.mjs windows production 1.2.0 <same-artifact-directory>
```

이미 검증한 GitHub Release가 공개됐다면 directory 대신 `--github-release`를 사용해 GitHub가 업로드 때 계산한 SHA-256 digest와 크기로 같은 feed를 생성할 수 있다. 이후 실제 다운로드를 Windows runner에서 feed와 대조해야 한다.

위 명령은 저장소 루트에서 실행한다. feed는 `flownote/public/updates/<channel>/windows.json`이다. 공개키 교체는 기존 앱이 새 키를 신뢰하지 않으므로 별도 키 이전 계획 없이 수행하면 안 된다. 새 버전마다 package version과 artifact/tag/feed version을 함께 증가시킨다.

`windows-app.yml`의 수동 `verify_updates=true`는 서명된 cloud staging feed에서 실제 EXE/ZIP을 다운로드하고 해시·캐시·동일 버전 skip을 검사한다. `update_only=true`는 rebuild 없이 공개한 정확한 EXE/ZIP을 설치하고 동일한 packaged Node fetch transport로 시험한다. 업데이트 feed를 staging-first 웹 배포로 검증한 뒤 같은 소스로 production에 승격한다. 1.0.0/초기 1.1.0 사용자는 1.1.1을 한 번 직접 설치해야 한다.

## 보안

웹 renderer에는 Node.js, preload/IPC bridge, webviewTag를 노출하지 않는다. sandbox/contextIsolation/webSecurity를 활성화하고 내부 이동은 환경별 고정 HTTPS origin에 제한한다. 외부 링크는 HTTPS/mailto/tel만 허용하며 시스템 브라우저로 연다. 파일 다운로드는 native 저장 대화상자를 사용한다. 서명키·서버 credential·테스트 계정을 패키지에 넣지 않는다.

GitHub Actions의 **Windows app**을 수동 실행하면 staging에서 확인한 설치형·portable·체크섬을 내려받을 수 있다. 공개 릴리스는 플랫폼의 앱 릴리스 절차를 따른다.

통합 검증 및 배포 절차는 [flownote-platform](https://github.com/lunce0503/flownote-platform)에서 관리한다.
