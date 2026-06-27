import { describe, it, expect } from 'vitest';
import { verifyEd25519 } from '../src/interactions/index';

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeKeyPair(): Promise<{ publicKeyHex: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pubRaw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  return { publicKeyHex: bytesToHex(new Uint8Array(pubRaw)), privateKey: pair.privateKey };
}

async function sign(privateKey: CryptoKey, timestamp: string, body: string): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(timestamp + body));
  return bytesToHex(new Uint8Array(sig));
}

describe('verifyEd25519 (Discord Interaction 署名検証)', () => {
  it('正しい鍵・署名 → true (PING 受け入れ)', async () => {
    const { publicKeyHex, privateKey } = await makeKeyPair();
    const body = '{"type":1}';
    const ts = '1700000000';
    const sig = await sign(privateKey, ts, body);
    expect(await verifyEd25519(body, sig, ts, publicKeyHex)).toBe(true);
  });

  it('body が改ざんされた → false', async () => {
    const { publicKeyHex, privateKey } = await makeKeyPair();
    const sig = await sign(privateKey, '1700000000', '{"type":1}');
    expect(await verifyEd25519('{"type":2}', sig, '1700000000', publicKeyHex)).toBe(false);
  });

  it('別鍵の公開鍵で検証 → false', async () => {
    const a = await makeKeyPair();
    const b = await makeKeyPair();
    const sig = await sign(a.privateKey, '1700000000', '{"type":1}');
    expect(await verifyEd25519('{"type":1}', sig, '1700000000', b.publicKeyHex)).toBe(false);
  });

  it('公開鍵フォーマット不正 → false (throw しない)', async () => {
    expect(await verifyEd25519('body', 'aabb', '0', 'not-hex')).toBe(false);
    expect(await verifyEd25519('body', 'aabb', '0', 'abc')).toBe(false); // odd-length
    expect(await verifyEd25519('body', 'aabb', '0', '')).toBe(false);
  });

  it('署名フォーマット不正 → false (throw しない)', async () => {
    const { publicKeyHex } = await makeKeyPair();
    expect(await verifyEd25519('body', 'zz', '0', publicKeyHex)).toBe(false);
  });
});
