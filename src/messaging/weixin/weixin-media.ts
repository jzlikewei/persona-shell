import { createCipheriv, createDecipheriv } from 'crypto';
import { writeFileSync, readFileSync } from 'fs';

// AES-128-ECB decrypt (WeChat CDN uses this for media)
function aesEcbDecrypt(data: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// AES-128-ECB encrypt (for upload)
function aesEcbEncrypt(data: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export async function downloadMedia(cdnUrl: string, aesKey: string, savePath: string): Promise<void> {
  const res = await fetch(cdnUrl);
  if (!res.ok) throw new Error(`CDN download failed: ${res.status} ${res.statusText}`);
  const encrypted = Buffer.from(await res.arrayBuffer());
  if (aesKey) {
    const decrypted = aesEcbDecrypt(encrypted, aesKey);
    writeFileSync(savePath, decrypted);
  } else {
    writeFileSync(savePath, encrypted);
  }
}

export async function uploadMedia(
  uploadUrl: string,
  filePath: string,
  aesKey: string,
): Promise<void> {
  const raw = readFileSync(filePath);
  const payload = aesKey ? aesEcbEncrypt(raw, aesKey) : raw;
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(payload),
  });
  if (!res.ok) throw new Error(`CDN upload failed: ${res.status} ${res.statusText}`);
}
