// O roteiro ponta a ponta do staging (Story 1.8), contra o cofre de teste, só com dados sintéticos.
// Roda na CI (.github/workflows/e2e-staging.yml), com as credenciais de teste do environment
// staging; nenhum valor é impresso. Três clientes de teste, como `ZIKARON_CLIENTS` os configura:
// `noah` (exposed, ownerClaims), `alan` (privileged) e `outro` (nenhum dos dois).
import { Buffer } from "node:buffer";
import process from "node:process";

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`falta ${name}`);
  return value;
};

const BASE = env("STAGING_URL").replace(/\/$/, "");
const REPO = env("VAULT_REPOSITORY");
const VAULT_TOKEN = env("E2E_VAULT_TOKEN");
const CLIENTS = Object.fromEntries(
  ["NOAH", "ALAN", "OUTRO"].map((name) => [
    name.toLowerCase(),
    { id: env(`E2E_${name}_CLIENT_ID`), secret: env(`E2E_${name}_CLIENT_SECRET`) },
  ]),
);
const RUN = `${new Date().toISOString().slice(0, 16).replace(/\D/g, "")}${Math.random().toString(36).slice(2, 6)}`;
const MARK = `E2E ${RUN}`;

let passed = 0;
const failures = [];
function check(name, ok) {
  if (ok) passed += 1;
  else failures.push(name);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
}

async function call(client, route, body, headers = {}) {
  const credentials =
    client === null
      ? {}
      : {
          "CF-Access-Client-Id": CLIENTS[client].id,
          "CF-Access-Client-Secret": CLIENTS[client].secret,
        };
  const response = await fetch(`${BASE}${route}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", ...credentials, ...headers },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // A borda do Access responde sem JSON.
  }
  return { status: response.status, json };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera até `test` dar verdadeiro, perguntando a cada 3 s, por até `seconds`. */
async function until(seconds, test) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    if (await test()) return true;
    if (Date.now() > end) return false;
    await sleep(3_000);
  }
}

async function github(method, path, body) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${VAULT_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "zikaron-e2e",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path.split("/")[0]}: ${response.status}`);
  return response.json();
}

const seen = async (client, path) => (await call(client, "/v1/read", { path })).json?.ok === true;
const searched = async (client, path) =>
  ((await call(client, "/v1/search", { query: MARK, k: 10 })).json?.notes ?? []).some(
    (note) => note.path === path,
  );
const recalled = async (client, path) =>
  (
    (await call(client, "/v1/recall", { question: `${MARK} sintético` })).json?.paths ?? []
  ).includes(path);
const pending = async (client, path) =>
  ((await call(client, "/v1/pending", {})).json?.notes ?? []).some((note) => note.path === path);
const mcpSearch = async (client, path) => {
  const { json } = await call(
    client,
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "memory_search", arguments: { query: MARK, k: 10 } },
    },
    { Accept: "application/json, text/event-stream" },
  );
  return JSON.stringify(json?.result ?? {}).includes(path);
};

async function main() {
  // 1. Sem credencial, a borda (ou o Worker) recusa.
  const anonymous = await call(null, "/v1/pending", {});
  check("sem credencial: recusado na borda", [401, 302, 403].includes(anonymous.status));

  // 2. O noah grava uma página de fora e algo que o dono disse.
  const outside = await call("noah", "/v1/write", {
    source: "external",
    evidence: `e2e:${RUN}:pagina`,
    title: `${MARK} pagina de fora`,
    body: "Conteúdo sintético lido de uma página de teste.",
    kind: "note",
  });
  check("noah grava uma nota de fora", outside.json?.ok === true);
  const said = await call("noah", "/v1/write", {
    source: "owner",
    evidence: `e2e:${RUN}:mensagem`,
    title: `${MARK} dito pelo dono`,
    body: "O dono disse uma preferência sintética.",
    kind: "preference",
  });
  check("noah grava o que o dono disse", said.json?.ok === true);
  const outsidePath = outside.json?.path ?? "";
  const saidPath = said.json?.path ?? "";

  // 3. Um contexto de rotina agendada não grava.
  const cron = await call("noah", "/v1/write", {
    source: "owner",
    context: "cron",
    title: `${MARK} da rotina`,
    body: "Não deveria entrar.",
    kind: "note",
  });
  check("uma rotina agendada não grava", cron.json?.reason === "cron");

  // 4. Depois do commit, o noah vê as duas.
  check(
    "noah vê as duas depois do commit",
    await until(
      90,
      async () => (await seen("noah", outsidePath)) && (await seen("noah", saidPath)),
    ),
  );

  // 5. O alan não vê a nota de fora em nenhum caminho, e vê o que o dono disse.
  check("alan não lê a nota de fora", !(await seen("alan", outsidePath)));
  check("alan não acha a nota de fora na busca", !(await searched("alan", outsidePath)));
  check("alan não recebe a nota de fora no recall", !(await recalled("alan", outsidePath)));
  check("alan não vê a nota de fora nas pendentes", !(await pending("alan", outsidePath)));
  check("alan não acha a nota de fora pelo MCP", !(await mcpSearch("alan", outsidePath)));
  check("noah acha a nota de fora na busca", await searched("noah", outsidePath));
  check("alan lê o que o dono disse", await seen("alan", saidPath));
  check("outro não vê a nota de fora", !(await seen("outro", outsidePath)));

  // 6. O dono confirma a nota de fora no GitHub, tirando o review: pending.
  const file = await github("GET", `contents/${outsidePath}`);
  const text = Buffer.from(file.content, "base64").toString("utf8");
  const confirmed = text.replace(/^ {2}review: pending\n/m, "");
  check("a nota de fora estava pendente", confirmed !== text);
  await github("PUT", `contents/${outsidePath}`, {
    message: "E2E: o dono confirma uma nota",
    content: Buffer.from(confirmed, "utf8").toString("base64"),
    sha: file.sha,
  });
  check("o «sim» no cofre a mostra para o alan", await until(120, () => seen("alan", outsidePath)));

  // 7. Uma nota escrita no GitHub chega ao recall pelo webhook.
  const ownersPath = `memory/notes/e2e-${RUN}-do-dono.md`;
  await github("PUT", `contents/${ownersPath}`, {
    message: "E2E: o dono escreve uma nota",
    content: Buffer.from(
      `# ${MARK} do dono\n\nNota sintética escrita direto no GitHub.\n`,
      "utf8",
    ).toString("base64"),
  });
  check(
    "a edição do dono chega ao recall do alan",
    await until(120, () => recalled("alan", ownersPath)),
  );

  console.log(`\n${passed}/${passed + failures.length} passaram (rodada ${RUN})`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`erro: ${error instanceof Error ? error.message : "desconhecido"}`);
  process.exitCode = 1;
});
