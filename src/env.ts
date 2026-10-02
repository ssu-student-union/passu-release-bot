type Env = {
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  DISCORD_WEBHOOK_URL: string;
  // 아래는 의존성 업데이트 PR 머지 버튼용. 비어 있으면 Discord 메시지를 보내지 않는다(패치 자동 머지는 그대로 동작)
  DISCORD_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_CHANNEL_ID?: string;
  // 머지 버튼을 누를 수 있는 Discord 역할 ID 또는 사용자 ID. 쉼표로 여러 개. 비어 있으면 아무도 누를 수 없다
  DISCORD_MERGE_ALLOWED_IDS?: string;
};

export type { Env };
