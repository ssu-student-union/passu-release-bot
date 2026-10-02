const encoder = new TextEncoder();

// GitHub 웹훅의 X-Hub-Signature-256(sha256=<hex>) 헤더가 본문과 시크릿으로 만든 HMAC과 같은지 확인한다.
async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;

  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  const expected = encoder.encode(toHex(signature));
  const actual = encoder.encode(header.slice("sha256=".length));

  if (expected.byteLength !== actual.byteLength) return false;
  return crypto.subtle.timingSafeEqual(expected, actual);
}

// Discord 인터랙션의 X-Signature-Ed25519가 (타임스탬프 + 본문)에 대한 앱 공개 키 서명인지 확인한다.
async function verifyDiscordSignature(
  publicKeyHex: string,
  body: string,
  signatureHex: string | null,
  timestamp: string | null,
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false;

  try {
    const key = await crypto.subtle.importKey("raw", fromHex(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, fromHex(signatureHex), encoder.encode(timestamp + body));
  } catch {
    // 헤더가 올바른 hex가 아니면 importKey·verify가 던진다
    return false;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export { verifyDiscordSignature, verifySignature };
