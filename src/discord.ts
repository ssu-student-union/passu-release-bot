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

export type { ReleaseNotice };
export { notifyRelease };
