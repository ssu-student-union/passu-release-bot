# passu-release-bot

패키지 레포에 새 Release가 올라오면 Discord로 알리고, 그 패키지를 쓰는 앱 레포마다 버전 업데이트 PR을 만들게 하는 GitHub App입니다. 업데이트 PR의 CI가 통과하면 패치 버전은 바로 머지하고, 마이너·메이저는 Discord의 머지 버튼으로 머지합니다.

```
passu-ui Release 발행
  └─ GitHub App 웹훅 → Worker
       ├─ Discord 알림
       └─ 앱 레포마다 repository_dispatch
            └─ 앱 레포의 워크플로가 pnpm add로 버전·lockfile 갱신 → 브랜치·PR 생성

업데이트 PR의 CI 완료 (workflow_run 웹훅) → Worker
  ├─ CI 실패·충돌 → Discord에 알림만
  ├─ 패치 → 바로 squash 머지, 브랜치 삭제
  └─ 마이너·메이저 → Discord에 [머지] 버튼
       └─ 허용된 역할·사람이 누르면 → PR 상태를 다시 확인하고 머지
```

머지 버튼을 누르면 그 사이 PR에 새 커밋이 올라왔는지, CI가 여전히 통과인지, 충돌이 없는지 다시 확인한 뒤 머지합니다. 새 커밋이 있으면 머지하지 않고, 그 커밋의 CI가 끝날 때 새 메시지를 보냅니다.

## 감시 대상 추가

`src/config.ts`의 `SOURCES`에 패키지 레포와 앱 레포를 추가합니다. 앱 레포에는 `templates/update-dependency.yml`을 `.github/workflows/`에 복사하고, 그 레포의 `pnpm-workspace.yaml`의 `minimumReleaseAgeExclude`에 패키지를 넣어 둡니다. (방금 나온 버전을 설치할 수 있어야 하므로)

## 설정

### GitHub App (릴리스 봇)

| 항목 | 값 |
|---|---|
| Webhook URL | Worker 주소 (`https://passu-release-bot.<계정>.workers.dev`) |
| Webhook secret | 임의의 긴 문자열 (Worker의 `GITHUB_WEBHOOK_SECRET`과 같게) |
| Subscribe to events | **Release**, **Workflow run** |
| Repository permissions | Contents: Read and write, Pull requests: Read and write, Actions: Read-only, Metadata: Read-only |
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

### 머지 버튼 (Discord 앱)

알림용 웹훅(`DISCORD_WEBHOOK_URL`)으로는 버튼을 달 수 없어서, 업데이트 PR 메시지는 Discord 봇으로 보냅니다. 설정하지 않으면 버튼 메시지만 빠지고 패치 자동 머지는 그대로 동작합니다.

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 앱을 만들고, Bot 탭에서 토큰을 발급합니다.
2. OAuth2 → URL Generator에서 `bot` 스코프와 `Send Messages`·`Embed Links` 권한으로 서버에 초대합니다.
3. General Information의 **Interactions Endpoint URL**에 `https://passu-release-bot.<계정>.workers.dev/discord`를 넣습니다. (Worker를 먼저 배포해야 저장됩니다)
4. 값을 등록하고 배포합니다.

```bash
pnpm exec wrangler secret put DISCORD_BOT_TOKEN
```

`wrangler.jsonc`의 `vars`에는 다음을 넣습니다.

| 이름 | 값 |
|---|---|
| `DISCORD_PUBLIC_KEY` | General Information의 Public Key |
| `DISCORD_CHANNEL_ID` | 메시지를 보낼 채널 ID (개발자 모드에서 채널 우클릭 → ID 복사) |
| `DISCORD_MERGE_ALLOWED_IDS` | 머지 버튼을 누를 수 있는 역할 ID 또는 사용자 ID. 쉼표로 여러 개, 섞어 써도 됩니다. 비어 있으면 아무도 누를 수 없습니다 |

## 개발

```bash
pnpm install
pnpm run typecheck
pnpm run dev   # .dev.vars에 시크릿을 넣고 실행
```
