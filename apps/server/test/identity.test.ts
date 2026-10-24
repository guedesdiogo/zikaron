// A identidade vem da credencial (ADR-0001 §1): o JWT do Access, validado no Worker.
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AccessApp,
  type Clients,
  clearKeyCache,
  clientOf,
  type KeyFetcher,
  parseClients,
  readerPolicy,
  verifyAccessJwt,
} from "../src/identity.ts";

const APP: AccessApp = { teamDomain: "https://time-teste.cloudflareaccess.com", aud: "aud-teste" };
const NOW = Date.parse("2026-10-24T12:00:00Z");
const SECONDS = NOW / 1000;

const encoder = new TextEncoder();
const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const jsonPart = (value: unknown) => base64Url(encoder.encode(JSON.stringify(value)));

async function keyPair() {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

let signing: CryptoKeyPair;
let other: CryptoKeyPair;
let fetches = 0;

async function publicJwk(pair: CryptoKeyPair, kid: string) {
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { ...jwk, kid, kty: "RSA", alg: "RS256" };
}

async function fetcherFor(...keys: [CryptoKeyPair, string][]): Promise<KeyFetcher> {
  const jwks = await Promise.all(keys.map(([pair, kid]) => publicJwk(pair, kid)));
  return async (url) => {
    expect(url).toBe(`${APP.teamDomain}/cdn-cgi/access/certs`);
    fetches += 1;
    return { keys: jwks as { kid: string; kty: string }[] };
  };
}

async function token(
  claims: Record<string, unknown> = {},
  options: { pair?: CryptoKeyPair; kid?: string; alg?: string } = {},
) {
  const header = jsonPart({ alg: options.alg ?? "RS256", kid: options.kid ?? "k1", typ: "JWT" });
  const payload = jsonPart({
    type: "app",
    aud: [APP.aud],
    iss: APP.teamDomain,
    iat: SECONDS - 10,
    exp: SECONDS + 3600,
    sub: "",
    common_name: "id-do-noah.access",
    ...claims,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    (options.pair ?? signing).privateKey,
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

const CLIENTS_JSON = JSON.stringify({
  "id-do-noah.access": { name: "noah", exposed: true, privileged: false, ownerClaims: true },
  "id-do-alan.access": { name: "alan", exposed: false, privileged: true, ownerClaims: false },
  "id-do-mac.access": { name: "mac", exposed: false, privileged: true, ownerClaims: false },
});

beforeEach(async () => {
  clearKeyCache();
  fetches = 0;
  signing ??= await keyPair();
  other ??= await keyPair();
});

describe("verifyAccessJwt", () => {
  it("devolve o Client ID de um service token válido", async () => {
    const fetcher = await fetcherFor([signing, "k1"]);
    expect(await verifyAccessJwt(await token(), APP, { now: NOW, fetcher })).toBe(
      "id-do-noah.access",
    );
  });

  it.each<[string, () => Promise<string | null>]>([
    ["sem token", async () => null],
    ["um token que não é JWT", async () => "abc.def"],
    ["outro algoritmo", () => token({}, { alg: "HS256" })],
    ["assinado por outra chave", () => token({}, { pair: other })],
    ["um kid desconhecido", () => token({}, { kid: "k9" })],
    ["outro aud", () => token({ aud: ["aud-de-outra-app"] })],
    ["outro iss", () => token({ iss: "https://outro-time.cloudflareaccess.com" })],
    ["vencido", () => token({ exp: SECONDS - 120 })],
    ["ainda não válido", () => token({ nbf: SECONDS + 600 })],
    ["emitido no futuro", () => token({ iat: SECONDS + 600 })],
    ["sem exp", () => token({ exp: undefined })],
    ["um login de pessoa", () => token({ email: "pessoa@example.com" })],
    ["de outro tipo", () => token({ type: "org" })],
    ["sem common_name", () => token({ common_name: "" })],
  ])("recusa %s", async (_label, make) => {
    const fetcher = await fetcherFor([signing, "k1"]);
    expect(await verifyAccessJwt(await make(), APP, { now: NOW, fetcher })).toBeNull();
  });

  it("recusa a assinatura adulterada", async () => {
    const fetcher = await fetcherFor([signing, "k1"]);
    const [header, , signature] = (await token()).split(".");
    const forged = `${header}.${jsonPart({ type: "app", aud: [APP.aud], iss: APP.teamDomain, exp: SECONDS + 60, common_name: "id-do-alan.access" })}.${signature}`;
    expect(await verifyAccessJwt(forged, APP, { now: NOW, fetcher })).toBeNull();
  });

  it("sem a aplicação configurada, ninguém entra", async () => {
    const fetcher = await fetcherFor([signing, "k1"]);
    expect(
      await verifyAccessJwt(await token(), { ...APP, aud: "" }, { now: NOW, fetcher }),
    ).toBeNull();
  });

  it("guarda as chaves e busca de novo quando o kid é novo", async () => {
    const fetcher = await fetcherFor([signing, "k1"], [other, "k2"]);
    await verifyAccessJwt(await token(), APP, { now: NOW, fetcher });
    await verifyAccessJwt(await token(), APP, { now: NOW + 1_000, fetcher });
    expect(fetches).toBe(1);
    expect(
      await verifyAccessJwt(await token({}, { pair: other, kid: "k3" }), APP, {
        now: NOW + 61_000,
        fetcher,
      }),
    ).toBeNull();
    expect(fetches).toBe(2);
  });
});

describe("as chaves do Access", () => {
  it("uma chave que não se importa, ou de outro algoritmo, não derruba as outras", async () => {
    const good = await publicJwk(signing, "k1");
    const fetcher: KeyFetcher = async () => ({
      keys: [
        { kid: "ruim", kty: "RSA", n: "x", e: "y" },
        { ...(await publicJwk(other, "k2")), alg: "RS512" },
        good,
      ] as { kid: string; kty: string }[],
    });
    expect(await verifyAccessJwt(await token(), APP, { now: NOW, fetcher })).toBe(
      "id-do-noah.access",
    );
    expect(
      await verifyAccessJwt(await token({}, { pair: other, kid: "k2" }), APP, {
        now: NOW,
        fetcher,
      }),
    ).toBeNull();
  });

  it("kids desconhecidos buscam as chaves de novo no máximo uma vez por minuto", async () => {
    const fetcher = await fetcherFor([signing, "k1"]);
    await verifyAccessJwt(await token(), APP, { now: NOW, fetcher });
    for (let i = 0; i < 20; i += 1) {
      await verifyAccessJwt(await token({}, { kid: `falso-${i}` }), APP, {
        now: NOW + i * 1_000,
        fetcher,
      });
    }
    expect(fetches).toBe(1);
    await verifyAccessJwt(await token({}, { kid: "falso-depois" }), APP, {
      now: NOW + 61_000,
      fetcher,
    });
    expect(fetches).toBe(2);
  });
});

describe("parseClients", () => {
  it("lê os clientes pelo Client ID", () => {
    const clients = parseClients(CLIENTS_JSON);
    expect(clients.get("id-do-noah.access")).toEqual({
      name: "noah",
      exposed: true,
      privileged: false,
      ownerClaims: true,
    });
    expect(clients.size).toBe(3);
  });

  it.each([
    ["vazia", ""],
    ["que não é objeto", "[]"],
    [
      "com nome fora do padrão",
      JSON.stringify({ a: { name: "Noah", exposed: true, privileged: false, ownerClaims: false } }),
    ],
    [
      "com flag que não é booleana",
      JSON.stringify({
        a: { name: "noah", exposed: "sim", privileged: false, ownerClaims: false },
      }),
    ],
    [
      "com chave desconhecida",
      JSON.stringify({
        a: { name: "noah", exposed: true, privileged: false, ownerClaims: false, admin: true },
      }),
    ],
    [
      "com cliente exposed e privileged",
      JSON.stringify({ a: { name: "noah", exposed: true, privileged: true, ownerClaims: false } }),
    ],
    [
      "com Client ID repetido",
      '{"a": {"name": "noah", "exposed": true, "privileged": false, "ownerClaims": false}, "a": {"name": "alan", "exposed": false, "privileged": true, "ownerClaims": false}}',
    ],
    [
      "com nome repetido",
      JSON.stringify({
        a: { name: "noah", exposed: true, privileged: false, ownerClaims: false },
        b: { name: "noah", exposed: false, privileged: false, ownerClaims: false },
      }),
    ],
    [
      "com o nome do próprio servidor",
      JSON.stringify({
        a: { name: "zikaron", exposed: false, privileged: false, ownerClaims: false },
      }),
    ],
  ])("recusa a configuração %s", (_label, json) => {
    expect(() => parseClients(json)).toThrow();
  });

  it("dá a cada cliente a política de leitura do ADR-0001", () => {
    const clients = parseClients(CLIENTS_JSON);
    const of = (id: string) =>
      readerPolicy(clients.get(id) as NonNullable<ReturnType<Clients["get"]>>, clients);
    expect(of("id-do-noah.access")).toEqual({
      client: "noah",
      mode: "exposed",
      trusted: ["alan", "mac"],
      ownerClaims: ["noah"],
    });
    expect(of("id-do-alan.access").mode).toBe("privileged");
  });
});

describe("clientOf", () => {
  it("só a credencial escolhe o cliente", async () => {
    const fetcher = await fetcherFor([signing, "k1"]);
    const clients = parseClients(CLIENTS_JSON);
    const request = (jwt: string | null, extra: Record<string, string> = {}) =>
      new Request("https://zikaron.example/mcp", {
        method: "POST",
        headers: { ...(jwt === null ? {} : { "Cf-Access-Jwt-Assertion": jwt }), ...extra },
        body: JSON.stringify({ client: "alan" }),
      });
    expect(
      (await clientOf(request(await token()), APP, clients, { now: NOW, fetcher }))?.name,
    ).toBe("noah");
    expect(
      await clientOf(request(null, { "X-Client": "alan" }), APP, clients, { now: NOW, fetcher }),
    ).toBeNull();
    expect(
      await clientOf(
        request(await token({ common_name: "id-desconhecido.access" })),
        APP,
        clients,
        {
          now: NOW,
          fetcher,
        },
      ),
    ).toBeNull();
  });
});
