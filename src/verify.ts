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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export { verifySignature };
