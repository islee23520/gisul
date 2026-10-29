<h1 align="center">skillar</h1>
<p align="center"><strong>내 스킬과 에이전트를 하나의 로컬 작업 공간으로.</strong></p>
<p align="center"><a href="README.md">English</a> · <a href="README.ko.md">한국어</a></p>
<p align="center">
  <a href="https://www.npmjs.com/package/skillar"><img src="https://img.shields.io/npm/v/skillar?color=c44b2b&amp;label=npm" alt="npm version"></a>
  <a href="https://github.com/changeroa/skillar/blob/main/local/package.json"><img src="https://img.shields.io/badge/Node.js-%E2%89%A524.15-333333" alt="Node.js 24.15 or newer"></a>
  <a href="https://github.com/changeroa/skillar/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-333333" alt="MIT license"></a>
</p>
<p align="center"><img src="https://raw.githubusercontent.com/changeroa/skillar/main/docs/assets/gisul-workshop.png" width="960" alt="기계 팔이 서랍장에서 작업 지침 카드를 꺼내 작업대로 옮기는 일러스트. 따뜻한 상아색 바탕의 검정과 주홍색 판화."></p>

이 머신에 있는 `SKILL.md` 폴더를 코딩 에이전트에 연결하세요. skillar는 MCP로 스킬을 검색하고, 세션마다 무엇을 검색하고 읽었는지 기록해 로컬 대시보드로 보여줍니다.

**제자리에서 색인 · 필요할 때 읽기 · 로컬에 기록**

[빠른 시작](#빠른-시작) · [지원 런타임](#지원-런타임) · [개인정보](#개인정보와-저장소) · [CLI와 설정](local/README.md)

## 빠른 시작

macOS 또는 Linux · **Node.js 24.15 이상**

> **gisool에서 업그레이드하나요?** 설치 **전에** [마이그레이션 안내](docs/migration-skillar.md)를 읽어 주세요. 두 패키지가 같은 `gisool` 명령을 사용하므로 바로 전역 설치하면 충돌합니다. `--force` 대신 데몬 중지, 백업, 패키지 교체 절차를 따르세요.

새로 설치한다면:

```sh
npm install -g skillar
skillar init --dry-run    # 설정과 서비스 변경 미리 보기; 파일을 쓰지 않음
skillar init              # 감지된 런타임 연결 및 백그라운드 서비스 설치
skillar open              # 로컬 대시보드 열기
```

`init`은 macOS에서 LaunchAgent, Linux에서 systemd 사용자 유닛을 설치합니다. 데몬은 `127.0.0.1:8799`에서 실행됩니다. 포그라운드로 실행하려면 `skillar init --no-service` 후 `skillar serve`를 사용하세요.

설치 상태는 `skillar doctor`로 점검합니다. 소스에서 설치하려면 [개발 환경 안내](local/README.md#develop)를 참고하세요.

## 스킬 폴더에서 세션 기록까지

| 단계 | 동작 |
| --- | --- |
| **검색** | 기존 스킬 루트를 복사하거나 수정하지 않고 색인합니다. 에이전트는 `search_skills`로 순위가 매겨진 후보를 받습니다. |
| **읽기** | 호스트가 MCP `resources/read`로 선택한 `SKILL.md`와 보조 파일을 읽습니다. 읽기 기록은 실행 허가를 뜻하지 않습니다. |
| **추적** | 대시보드에서 세션, 검색 후보, 스킬 읽기, 작업 → 스킬 → 결과 흐름, 요일·시간별 활동을 확인합니다. |

런타임 훅이나 텔레메트리가 알려 주면 에이전트가 직접 사용한 스킬도 관찰합니다. [스킬 추적 안내](local/docs/skill-tracing.md)는 귀속 방식과 증거의 한계, **pane·session 추적에 필요한 herdr**를 설명합니다. herdr에 연결되지 않아도 MCP 제공과 세션 수집은 계속됩니다.

## 지원 런타임

| 런타임 | `--runtime` ID |
| --- | --- |
| Claude Code | `claude-code` |
| Codex | `codex` |
| Gemini CLI | `gemini` |
| Cursor | `cursor` |
| OmO | `omo` |
| Gajae Code | `gajae` |
| OpenClaw | `openclaw` |

`init`이 설치된 런타임을 감지합니다. 일부만 연결하려면 `skillar init --runtime codex,claude-code`를 사용하세요. 팩은 MCP와 런타임별 텔레메트리 또는 캡처 훅을 설정하며, 수집 범위는 런타임마다 다릅니다.

MCP 리비전 **2026-07-28**과 레거시 `initialize` 핸드셰이크를 모두 지원합니다. 스킬 본문을 읽으려면 호스트 리소스 리더가 필요합니다. 헤더, stdio, 레거시 전송 방식의 제약은 [프로토콜 안내](local/README.md#skills-over-mcp)에 있습니다.

## 개인정보와 저장소

skillar 데몬은 색인과 프롬프트·검색·읽기 기록을 로컬 SQLite에 저장하며, 수집한 텔레메트리를 원격 서비스에 업로드하지 않습니다. 데몬은 루프백에서만 수신하고 MCP·수집·API 요청에 로컬 bearer 토큰을 요구합니다. 대시보드는 로컬 인증 쿠키를 사용합니다. 연결된 에이전트와 모델 제공자의 데이터 처리는 별개입니다.

`~/.skillar/config.json`에서 보관 범위를 선택하세요.

| 설정 | 동작 |
| --- | --- |
| `captureLevel: "full"` | 수집한 텍스트를 그대로 저장합니다(기본값). |
| `captureLevel: "redacted"` | 인식한 비밀값을 마스킹하고 2,048자로 자릅니다. 모든 비밀값 제거를 보장하지는 않습니다. |
| `captureLevel: "metadata"` | 텍스트 없이 다이제스트와 길이만 보관합니다. |
| `retentionDays` | 오래된 세션을 삭제합니다. `null`이면 계속 보관합니다. |

새 설치는 `~/.skillar/`를 사용하며 `SKILLAR_HOME`으로 다른 홈을 선택할 수 있습니다. 기존 레거시 홈과 데이터베이스는 [마이그레이션 규칙](docs/migration-skillar.md#local-state-and-configuration)에 따라 재사용합니다.

| 선택된 홈 안의 경로 | 용도 |
| --- | --- |
| `config.json` | 포트, 캡처 수준, 보존 기간, 스킬 루트 |
| `token` | 로컬 bearer 토큰, 권한 `0600` |
| `skillar.db` | 스킬 색인, 세션, 이벤트, 읽기 기록. 기존 `gisool.db`는 제자리에 유지 |
| `logs/daemon.log` | 데몬 로그 |
| `backups/` | 롤백에 쓰는 실행별 설정 백업 |

## 점검하고, 되돌리고, 옮기기

```sh
skillar doctor                                  # 데몬, 서비스, 색인, 캡처, herdr 점검
skillar doctor --json
skillar init --rollback                         # 마지막 init 실행 되돌리기
skillar init --rollback --all                    # 모든 실행 되돌리기
skillar export ~/skillar-backup                  # 설정만 내보내기
skillar export ~/skillar-backup --with-history   # 세션·이벤트·읽기 기록도 포함
skillar import ~/skillar-backup --dry-run        # 미리 보기; 기존 키는 유지
skillar eval                                    # 검색 품질 측정
```

`skillar open --print`는 브라우저를 열지 않고 대시보드 URL만 출력합니다. 가져오기, 서비스 관리, 설정, 프로토콜의 자세한 내용은 [CLI 안내](local/README.md)에 있습니다.

## 문서

| 안내 | 내용 |
| --- | --- |
| [로컬 CLI와 MCP](local/README.md) | 설치, 명령, 설정, 프로토콜 레퍼런스 |
| [업그레이드와 호환성](docs/migration-skillar.md) | 안전한 패키지 교체, 레거시 홈·명령·식별자 |
| [스킬 추적](local/docs/skill-tracing.md) | 캡처 범위, herdr 연결, 귀속과 증거의 한계 |
| [아키텍처](docs/skillar.md) | 데몬, 저장소, 수집 경로, API 설계 |

## 원격 레지스트리와 팀 배포

로컬 CLI에는 호스팅 레지스트리가 필요하지 않습니다. 이 저장소에는 별도의 [Node.js 레지스트리](server/README.md)(`server/`, stdio 또는 Streamable HTTP)와 비공개 R2의 불변 릴리스를 인증 후 제공하는 Cloudflare Worker(`worker/`)도 있습니다. 두 서버는 [SEP-2640 Skills Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640)을 구현합니다.

**이전 개인 Cloudflare 배포는 2026-10-29에 종료되었습니다.** 과거 주소는 유지 중인 엔드포인트가 아니며, 조직 배포는 별도의 외부 리소스입니다. 직접 호스팅하려면 자체 설정과 릴리스 검증이 필요합니다. `skillar init --disable-remote`로 연결된 런타임의 원격 등록을 끌 수 있습니다.

<details>
<summary>레지스트리 클라이언트, 배포, 과거 맥락</summary>

| 런타임 | 연동 |
| --- | --- |
| Codex | [팀 자체 호스팅 HTTPS + OAuth 플러그인](docs/team-plugin.md) · [Codex 클라이언트](clients/codex/README.md) |
| oh-my-openagent / OmO 5 (`omo-ai`) | [OAuth stdio 브리지와 탐색 확장](clients/oh-my-openagent/README.md) |
| Gajae Code (`gjc`) | [OAuth stdio 브리지와 워크플로 연동](clients/gajae-code/README.md) |
| OpenClaw | [OAuth stdio 브리지와 부트스트랩 탐색 훅](clients/openclaw/README.md) |

Worker는 `SKILLS_BUCKET`, 읽기용 `SKILLAR_BEARER_TOKEN`, 별도의 게시용 `SKILLAR_PUBLISH_TOKEN`을 사용합니다. `server/ops/`는 새 설치용 템플릿이며 실제 자격 증명이나 운영 중인 배포의 증거가 아닙니다.

[배포, 불변 릴리스 형식, 롤백, 프로덕션 게이트](docs/deployment.md) · [팀 자체 호스팅](docs/team-plugin.md) · [과거 세션 인수인계](docs/SESSION_CONTEXT.md)

</details>

## 기여

Node.js 24와 npm을 설치한 뒤 체크아웃에서 `node scripts/verify.mjs`를 실행하면 CI와 같은 잠금 의존성 설치, 빌드, 테스트, 검색·플러그인 검사, Worker dry-run을 수행한다. 배포하거나 콘텐츠를 발행하지는 않는다.

## 라이선스

[MIT](LICENSE). 이름은 **기술**(skill, craft, technique)에서 왔습니다.
