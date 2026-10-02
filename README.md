# passu-release-bot

패키지 레포에 새 Release가 올라오면 Discord로 알리고, 그 패키지를 쓰는 앱 레포마다 버전 업데이트 PR을 만들게 하는 GitHub App입니다.

```
passu-ui Release 발행
  └─ GitHub App 웹훅 → Worker
       ├─ Discord 알림
       └─ 앱 레포마다 repository_dispatch
            └─ 앱 레포의 워크플로가 pnpm add로 버전·lockfile 갱신 → 브랜치·PR 생성
```

## 감시 대상 추가

`src/config.ts`의 `SOURCES`에 패키지 레포와 앱 레포를 추가합니다. 앱 레포에는 `templates/update-dependency.yml`을 `.github/workflows/`에 복사하고, 그 레포의 `pnpm-workspace.yaml`의 `minimumReleaseAgeExclude`에 패키지를 넣어 둡니다. (방금 나온 버전을 설치할 수 있어야 하므로)

## 설정

### GitHub App (릴리스 봇)

| 항목 | 값 |
|---|---|
| Webhook URL | Worker 주소 (`https://passu-release-bot.<계정>.workers.dev`) |
| Webhook secret | 임의의 긴 문자열 (Worker의 `GITHUB_WEBHOOK_SECRET`과 같게) |
| Subscribe to events | **Release** |
| Repository permissions | Contents: Read and write, Pull requests: Read and write, Metadata: Read-only |
| 설치 대상 | 패키지 레포와 모든 앱 레포 |

### Worker

`wrangler.jsonc`의 `GITHUB_APP_CLIENT_ID`에 App의 Client ID를 넣고, 시크릿을 등록합니다.

```bash
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < app.private-key.pem   # App에서 받은 .pem 그대로
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm exec wrangler secret put DISCORD_WEBHOOK_URL
pnpm run deploy
```

### 앱 레포 워크플로

조직 변수 `RELEASE_BOT_CLIENT_ID`와 조직 시크릿 `RELEASE_BOT_PRIVATE_KEY`를 씁니다. (패키지 레포의 릴리스 워크플로와 같은 값) 두 항목의 접근 가능 레포에 앱 레포를 추가해야 합니다.

## 개발

```bash
pnpm install
pnpm run typecheck
pnpm run dev   # .dev.vars에 시크릿을 넣고 실행
```
