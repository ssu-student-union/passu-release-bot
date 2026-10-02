type ReleaseNotice = {
  packageName: string;
  version: string;
  releaseUrl: string;
  notes: string;
  consumers: string[];
};

// Discord 임베드 설명은 최대 4096자라서 릴리스 노트가 길면 자른다.
const MAX_NOTES = 3500;

async function notifyRelease(webhookUrl: string, notice: ReleaseNotice): Promise<void> {
  const notes =
    notice.notes.length > MAX_NOTES ? `${notice.notes.slice(0, MAX_NOTES)}\n…(Release에서 전체 보기)` : notice.notes;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title: `${notice.packageName}@${notice.version} 배포`,
          url: notice.releaseUrl,
          description: notes || undefined,
          color: 0x57f287,
          fields: notice.consumers.length
            ? [{ name: "업데이트 PR 생성 요청", value: notice.consumers.map((repo) => `\`${repo}\``).join(", ") }]
            : undefined,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Discord 알림 실패 (${res.status}): ${await res.text()}`);
}

const DISCORD_API = "https://discord.com/api/v10";

type Bump = "major" | "minor" | "patch";

// 앱 레포의 의존성 업데이트 PR 하나
type UpdatePr = {
  repo: string;
  number: number;
  url: string;
  sha: string;
  packageName: string;
  from: string;
  to: string;
  bump: Bump;
};

type UpdateStatus =
  | { kind: "ready" }
  | { kind: "ci-failed"; failed: string[] }
  | { kind: "conflict" }
  | { kind: "merged"; by: string | null }
  | { kind: "merge-failed"; reason: string };

type DiscordMessage = {
  embeds: object[];
  components: object[];
  allowed_mentions: { parse: string[] };
};

// 버튼의 custom_id. Discord는 최대 100자까지 받는다.
function mergeButtonId(pr: UpdatePr): string {
  return `merge:${pr.repo}:${pr.number}:${pr.sha}`;
}

function parseMergeButtonId(customId: string): { repo: string; number: number; sha: string } | null {
  const match = /^merge:([\w.-]+):(\d+):([0-9a-f]{40})$/.exec(customId);
  return match ? { repo: match[1], number: Number(match[2]), sha: match[3] } : null;
}

const YELLOW = 0xfee75c;
const RED = 0xed4245;
const GREEN = 0x57f287;

function describe(status: UpdateStatus): { color: number; text: string } {
  switch (status.kind) {
    case "ready":
      return { color: YELLOW, text: "CI 통과 · 머지 대기" };
    case "ci-failed":
      return { color: RED, text: `CI 실패: ${status.failed.join(", ")} · 코드 수정이 필요해요` };
    case "conflict":
      return { color: RED, text: "충돌이 있어 머지할 수 없어요" };
    case "merged":
      return {
        color: GREEN,
        text: status.by ? `<@${status.by}>님이 머지했어요` : "패치 버전이라 자동으로 머지했어요",
      };
    case "merge-failed":
      return { color: RED, text: `머지 실패: ${status.reason}` };
  }
}

function updateMessage(pr: UpdatePr, status: UpdateStatus): DiscordMessage {
  const { color, text } = describe(status);
  const buttons: object[] = [];
  if (status.kind === "ready") {
    buttons.push({ type: 2, style: 3, label: "머지", custom_id: mergeButtonId(pr) });
  }
  buttons.push({ type: 2, style: 5, label: `PR #${pr.number}`, url: pr.url });

  return {
    embeds: [
      {
        title: `${pr.repo} · ${pr.packageName} ${pr.from} → ${pr.to} (${pr.bump})`,
        url: pr.url,
        description: text,
        color,
      },
    ],
    components: [{ type: 1, components: buttons }],
    // 머지한 사람 표시는 멘션 형식이지만 알림은 보내지 않는다
    allowed_mentions: { parse: [] },
  };
}

async function sendChannelMessage(botToken: string, channelId: string, message: DiscordMessage): Promise<void> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${botToken}` },
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error(`Discord 메시지 전송 실패 (${res.status}): ${await res.text()}`);
}

// 버튼을 누른 원본 메시지를 고친다. 인터랙션 토큰은 15분 동안 쓸 수 있다.
async function editInteractionMessage(applicationId: string, token: string, message: DiscordMessage): Promise<void> {
  const res = await fetch(`${DISCORD_API}/webhooks/${applicationId}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error(`Discord 메시지 수정 실패 (${res.status}): ${await res.text()}`);
}

export type { Bump, DiscordMessage, ReleaseNotice, UpdatePr, UpdateStatus };
export { editInteractionMessage, notifyRelease, parseMergeButtonId, sendChannelMessage, updateMessage };
