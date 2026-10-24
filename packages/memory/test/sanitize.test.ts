import { describe, expect, it } from "vitest";
import { sanitizeSecrets } from "../src/index.ts";

// Secrets are assembled at run time, so no key-shaped literal sits in the repository for GitHub's
// push protection to flag.
const join = (...parts: string[]) => parts.join("");
const tail = (length: number, alphabet = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ") =>
  Array.from({ length }, (_, i) => alphabet[i % alphabet.length]).join("");

describe("sanitizeSecrets", () => {
  it.each([
    ["bearer_token", join("Authorization: ", "Bearer ", tail(24))],
    ["api_key", join("sk", "-", tail(32))],
    ["stripe_key", join("sk", "_live_", tail(24))],
    ["github_token", join("gh", "p_", tail(36))],
    ["github_token", join("github", "_pat_", tail(40))],
    ["aws_key", join("AK", "IA", tail(16, "ABCDEFGHIJKLMNOP0123456789"))],
    ["google_api_key", join("AI", "za", tail(35))],
    ["telegram_token", join("123456789", ":", "AA", tail(33))],
    ["slack_token", join("xo", "xb-", tail(30))],
    ["jwt", join("ey", "J", tail(20), ".", tail(30), ".", tail(30))],
    ["url_credentials", join("postgres://kelpie:", tail(12), "@db.example.com:5432/vault")],
    ["env_secret", join("OPENAI", "_API_KEY=", tail(20))],
    ["env_secret", join("MY_SERVICE", "_TOKEN=", tail(20))],
    // ai-memory's suffixes one step outside KEY and TOKEN, uppercase only (#196).
    ["env_secret", join("LITESTREAM_ACCESS", "_KEY_ID=", tail(32))],
    ["env_secret", join("GPG", "_PASSPHRASE=", tail(20))],
    ["env_secret", join("RELEASE", "_SIGNING_KEY=", tail(20))],
    ["env_secret", join("AUTH_TOKEN", "_PEPPER=", tail(30))],
    ["env_secret", join("PASSWORD", "_SALT: ", tail(18))],
    // A dotless base64 JSON object, as a Cloudflare tunnel token is handed out.
    ["base64_json_token", join("ey", "J", tail(60), "=")],
    // Gemini's auth keys, issued instead of AIza ones since 2026-05.
    ["google_api_key", join("AQ", ".Ab", tail(48))],
  ])("redacts a %s", (kind, secret) => {
    const { text, redactions } = sanitizeSecrets(`antes ${secret} depois`);
    expect(text).toContain(`[REDACTED:${kind}]`);
    expect(text).not.toContain(secret.slice(-12));
    expect(text.startsWith("antes ")).toBe(true);
    expect(redactions).toBeGreaterThan(0);
  });

  it("redacts a private key, terminated or cut off", () => {
    const body = tail(64);
    const whole = join(
      "-----BEGIN ",
      "PRIVATE KEY-----\n",
      body,
      "\n-----END ",
      "PRIVATE KEY-----",
    );
    expect(sanitizeSecrets(`a ${whole} b`).text).toBe("a [REDACTED:private_key] b");
    const cut = join("-----BEGIN ", "RSA PRIVATE KEY-----\n", body);
    expect(sanitizeSecrets(`a ${cut}`).text).toBe("a [REDACTED:private_key]");
  });

  it.each([
    "Reunião às 14:30, sala 12:00-13:00, ASIAPACIFICREGION, pit-stop-strategy, R$ 1.200,50, chave da casa com a Lúcia.",
    "O segredo do bolo é a manteiga.",
    "A chave do carro está na mesa.",
    "O token é válido até amanhã, e o código é 123456.",
    "Rode mkdir -p fotos e depois ssh -p 22 servidor.",
    "Vou passar na padaria às 8h.",
    "Esqueci minha senha e preciso recuperar.",
    "A senha é muito importante.",
    "Compass: norte. Token: expirado. O segredo: saber esperar. Pass: 3 x 2.",
    "Eu comi um cookie: delicioso.",
  ])("leaves ordinary text alone: %s", (ordinary) => {
    expect(sanitizeSecrets(ordinary)).toEqual({ text: ordinary, redactions: 0 });
  });

  // ai-memory's cases for the same rules (#196): code identifiers, digests and short fragments.
  it.each([
    "let api_key_id = row.get(0);",
    "pub password_salt: String,",
    "struct Row { user_key_id: u64 }",
    "add a pinch of SALT and a KEY_ID column",
    "commit 1f0775428a9e4b1c2d3e4f5a6b7c8d9e0f1a2b3c",
    "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "request 3b58f2d3-c1ac-81b2-b387-dd04ff9a3d11",
    "payload eyJhIjoi",
    "see AQ.Ab for details, and the AQ.A section",
  ])("leaves this alone: %s", (ordinary) => {
    expect(sanitizeSecrets(ordinary)).toEqual({ text: ordinary, redactions: 0 });
  });

  it("strips terminal escapes, controls and bidirectional overrides before matching", () => {
    const split = join("gh", "p_", tail(18), "\u001b[31m", tail(18));
    const { text } = sanitizeSecrets(`x ${split} \u202eevil\u0007`);
    expect(text).toBe("x [REDACTED:github_token] evil");
  });

  it("is idempotent", () => {
    const once = sanitizeSecrets(
      join("OPENAI", "_API_KEY=", tail(20), " e ", "Bearer ", tail(24)),
    ).text;
    expect(sanitizeSecrets(once)).toEqual({ text: once, redactions: 0 });
    for (const redacted of [
      "o token do bot: [REDACTED:telegram_token]",
      "senha: [REDACTED:password]",
      "secret is [REDACTED:api_key]",
    ]) {
      expect(sanitizeSecrets(redacted)).toEqual({ text: redacted, redactions: 0 });
    }
  });

  it("stays fast on long text", () => {
    const started = Date.now();
    sanitizeSecrets(`${"password-token-key=".repeat(5_000)} ${"a".repeat(100_000)}`);
    sanitizeSecrets("eyJ".repeat(20_000));
    sanitizeSecrets(`senha ${"palavra ".repeat(10_000)}`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.each([
    [
      "the Bot API URL",
      join("https://api.telegram.org/bot", "123456789", ":", "AA", tail(33), "/getMe"),
    ],
    [
      "a PGP key",
      join(
        "-----BEGIN ",
        "PGP PRIVATE KEY BLOCK-----\n",
        tail(64),
        "\n-----END ",
        "PGP PRIVATE KEY BLOCK-----",
      ),
    ],
    ["a Google access token", join("ya", "29.", tail(40))],
    ["an npm token", join("np", "m_", tail(36))],
    ["a Hugging Face token", join("h", "f_", tail(34))],
    ["a SendGrid key", join("S", "G.", tail(22), ".", tail(43))],
    ["a webhook secret", join("whs", "ec_", tail(32))],
    ["a Stripe test key", join("sk", "_test_", tail(24))],
    ["a GitLab token", join("glp", "at-", tail(20))],
    ["a cookie", join("Cookie: session=", tail(32), "; theme=dark")],
    ["curl credentials", join("curl https://x.example -u admin:", tail(12))],
    ["a token as URL user", join("https://", tail(40, "0123456789abcdef"), "@github.com/o/r.git")],
    ["an AWS secret key", join("aws secret access key: ", tail(40, "AbCdEf0123456789+/GhIj"))],
    ["a Cloudflare token", join("o token da Cloudflare é ", tail(40, "AbCdEf0123456789_-GhIj"))],
  ])("redacts %s", (_label, secret) => {
    const { text } = sanitizeSecrets(`antes ${secret} depois`);
    expect(text).toContain("[REDACTED:");
    expect(text).not.toContain(secret.slice(-10));
  });

  it.each([
    "minha senha é Tr0ub4dor&3xyz",
    "senha: Tr0ub4dor&3xyz",
    "my password is P@ssw0rd!2024",
    "password: 'Tr0ub4dor&3xyz'",
    "password=Sup3r$ecret99",
    '{"token": "a1b2c3d4e5f6"}',
    '{"senha":"segredo-da-casa"}',
    "accessToken: a1b2c3d4e5f6g7",
    "clientSecret=a1b2c3d4e5f6g7",
    "DB_PASS=correct-horse-battery",
    "pwd=a1b2c3d4!",
    "contraseña: hunter2hunter2",
  ])("redacts a password or token in %s", (phrase) => {
    const secret =
      phrase.match(
        /(Tr0ub4dor&3xyz|P@ssw0rd!2024|Sup3r\$ecret99|a1b2c3d4e5f6(?:g7)?|segredo-da-casa|correct-horse-battery|a1b2c3d4!|hunter2hunter2)/,
      )?.[0] ?? "";
    const { text } = sanitizeSecrets(`antes ${phrase} depois`);
    expect(text).toContain("[REDACTED:");
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/&3|!2024/);
  });

  it.each([
    ["a colon after the verb", "the password is: Abc12345"],
    ["a colon after é", "senha é: Abc12345"],
    ["what the password is for", "a senha do gmail é Abc12345"],
    ["a field with what it is for", "senha do wifi: Abc12345"],
    ["a field with what it is for, in English", "password for gmail: Abc12345"],
    ["está", "a senha está Abc12345"],
    ["a bracketed value", "password: [Abc12345]"],
    ["a list of passwords", '"passwords": ["Abc12345"]'],
    ["a bold field name", "**password**: Abc12345"],
    ["a code field name", "`password`: Abc12345"],
    ["a token in prose", "my token is abcd1234efgh5678"],
    ["an API key in prose", "my api key is Qz8vLm2pXw9rTt4y"],
    ["a secret in prose", "o segredo é Abc12345xyz"],
    ["a private key in hex", join("private key: 0x", tail(64, "0123456789abcdef"))],
    ["a quoted passphrase", 'password = "correct horse battery staple"'],
    ["a CLI flag", "login --password Abc12345 --user me"],
    ["a token flag", "deploy --token Abc12345xyz"],
    ["sshpass", "sshpass -p Abc12345 ssh me@host"],
    ["a capitalized colon", "A senha é: Abc12345"],
    ["whose password it is", "senha dela é: Abc12345"],
    ["an adjective", "minha senha nova é Abc12345"],
    ["eh", "senha eh Abc12345"],
    ["Spanish", "mi clave es Abc12345"],
    ["a token in Portuguese prose", "o token é Abc12345xyz"],
    ["a bare secret in prose", "secret is Abc12345xyz"],
    ["curl with no space", "curl -uadmin:Abc12345 https://x.example"],
    ["curl with an equals sign", "curl --user=admin:Abc12345 https://x.example"],
    ["a semicolon in the value", "senha: Abc;Abc12345"],
  ])("redacts a password named with %s", (_label, phrase) => {
    const { text } = sanitizeSecrets(`antes ${phrase} depois`);
    expect(text).toContain("[REDACTED:");
    expect(text).not.toMatch(/Abc12345|abcd1234|Qz8vLm2p|horse battery|0123456789abcdef/);
  });

  it.each([
    ["a password-only URL", join("redis://:", tail(16), "@cache.example.com:6379")],
    [
      "a signed URL",
      join("https://b.example.com/f?X-Amz-Signature=", tail(40, "0123456789abcdef")),
    ],
    ["an Azure SAS", join("https://a.blob.example.net/c?sv=2024&sig=", tail(40), "&se=1")],
    ["a DigitalOcean token", join("do", "p_v1_", tail(64, "0123456789abcdef"))],
    ["a Shopify token", join("shp", "at_", tail(32, "0123456789abcdef"))],
    ["a PyPI token", join("py", "pi-AgEIcHlwaS5vcmc", tail(60))],
    ["a Supabase key", join("sb_", "secret_", tail(32))],
    ["a Linear key", join("lin", "_api_", tail(40))],
    ["a Notion token", join("nt", "n_", tail(46))],
    [
      "a Postman key",
      join("PM", "AK-", tail(24, "0123456789abcdef"), "-", tail(34, "0123456789abcdef")),
    ],
    ["a Google client secret", join("GOC", "SPX-", tail(28))],
    ["a Twilio key", join("S", "K", tail(32, "0123456789abcdef"))],
    [
      "a Slack webhook",
      join("https://hooks.", "slack.com/services/", tail(9), "/", tail(11), "/", tail(24)),
    ],
    [
      "a Discord webhook",
      join("https://discord.com/api/", "webhooks/", "123456789012345678/", tail(68)),
    ],
    ["a Cloudflare global key", join("Cloudflare global key ", tail(37, "0123456789abcdef"))],
    ["a key body with no header", join("MII", "EvQIBADANBgkqhkiG9w0BAQEFAASC", tail(64))],
    ["an OpenSSH key body with no header", join("b3BlbnNzaC1", "rZXktdjE", tail(64))],
  ])("redacts %s", (_label, secret) => {
    const { text } = sanitizeSecrets(`antes ${secret} depois`);
    expect(text).toContain("[REDACTED:");
    expect(text).not.toContain(secret.slice(-10));
  });

  it.each([
    ["a key body", "MII", "EvQIBADANBgkqhkiG9w0BAQEFAASC", 64],
    ["an OpenSSH key body", "b3BlbnNzaC1", "rZXktdjE", 70],
  ])("redacts %s with no header across the lines it wraps onto (#326)", (_label, a, b, width) => {
    const body = join(a, b, tail(26 * width));
    const wrapped = (body.match(new RegExp(`.{1,${width}}`, "g")) ?? []).join("\n");
    const last = `${tail(9)}==`;
    const { text } = sanitizeSecrets(`colei a chave:\n${wrapped}\n${last}\nObrigado, até amanhã.`);
    expect(text).toContain("[REDACTED:private_key]");
    // No line of the key is left, the short last one included; the sentence after it stays.
    expect(text).not.toMatch(/[A-Za-z0-9+/]{16,}/);
    expect(text).not.toContain(last);
    expect(text).toContain("colei a chave:");
    expect(text).toContain("até amanhã.");
  });

  it.each([
    ["a zero-width joiner", "\u200d"],
    ["a combining grapheme joiner", "\u034f"],
    ["a variation selector", "\ufe0f"],
    ["an Arabic letter mark", "\u061c"],
    ["a Mongolian vowel separator", "\u180e"],
    ["a Hangul filler", "\u3164"],
    ["a Braille blank", "\u2800"],
    ["a tag character", "\u{e0041}"],
  ])("finds a secret split by %s", (_label, invisible) => {
    const hidden = join("sk", "-", tail(10), invisible, tail(20));
    expect(sanitizeSecrets(`x ${hidden}`).text).toBe("x [REDACTED:api_key]");
  });

  it("drops tag characters, and reads decomposed accents", () => {
    expect(sanitizeSecrets("oi\u{e0049}\u{e0067}\u{e006e}").text).toBe("oi");
    const { text } = sanitizeSecrets("contrase\u006e\u0303a: hunter2hunter2");
    expect(text).not.toContain("hunter2");
  });

  it("finds a secret hidden by a zero-width space, and keeps emoji, apart", () => {
    const hidden = join("sk", "-", tail(10), "\u200b", tail(20));
    expect(sanitizeSecrets(`x ${hidden}`).text).toBe("x [REDACTED:api_key]");
    expect(sanitizeSecrets("dev \u{1F469}\u{1F3FD}\u200d\u{1F4BB}").text).toBe(
      "dev \u{1F469}\u{1F3FD}\u{1F4BB}",
    );
  });
});
