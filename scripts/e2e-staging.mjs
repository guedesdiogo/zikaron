// The staging end-to-end run (Story 1.8), against the test vault, with synthetic data only. It runs
// in CI (.github/workflows/e2e-staging.yml), with the test credentials of the staging environment;
// no value is printed. Three test clients, as `ZIKARON_CLIENTS` configures them: `noah` (exposed,
// ownerClaims), `alan` (privileged) and `outro` (neither). The notes it writes keep Portuguese
// synthetic text, like the test fixtures.
import { Buffer } from "node:buffer";
import process from "node:process";

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing ${name}`);
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
    // The Access edge answers without JSON.
  }
  return { status: response.status, json };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `test` is true, asking every 3 s, for up to `seconds`. */
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

/** A call that has to succeed: 200 with JSON; otherwise the run stops, without a false pass. */
async function answered(client, route, body, headers) {
  const result = await call(client, route, body, headers);
  if (result.status !== 200 || result.json === null) {
    throw new Error(`${route} answered ${result.status}`);
  }
  return result.json;
}

const seen = async (client, path) => {
  const json = await answered(client, "/v1/read", { path });
  if (json.ok === true) return true;
  if (json.reason === "not_found") return false;
  throw new Error(`/v1/read refused: ${json.reason}`);
};
const searched = async (client, path) => {
  const json = await answered(client, "/v1/search", { query: MARK, k: 10 });
  if (json.ok !== true || !Array.isArray(json.notes)) throw new Error("/v1/search failed");
  return json.notes.some((note) => note.path === path);
};
const recalled = async (client, path) => {
  const json = await answered(client, "/v1/recall", { question: `${MARK} sintético` });
  if (!Array.isArray(json.paths)) throw new Error("/v1/recall failed");
  return json.paths.includes(path);
};
const pending = async (client, path) => {
  const json = await answered(client, "/v1/pending", {});
  if (json.ok !== true || !Array.isArray(json.notes)) throw new Error("/v1/pending failed");
  return json.notes.some((note) => note.path === path);
};
const mcpSearch = async (client, path) => {
  const json = await answered(
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
  if (json.error !== undefined || json.result === undefined || json.result.isError === true) {
    throw new Error("memory_search failed");
  }
  return JSON.stringify(json.result).includes(path);
};

async function main() {
  // 1. Without a credential, the edge (or the Worker) refuses.
  const anonymous = await call(null, "/v1/pending", {});
  check("no credential: refused at the edge", [401, 302, 403].includes(anonymous.status));

  // 2. noah writes an outside page and something the owner said.
  const outside = await call("noah", "/v1/write", {
    source: "external",
    evidence: `e2e:${RUN}:pagina`,
    title: `${MARK} pagina de fora`,
    body: "Conteúdo sintético lido de uma página de teste.",
    kind: "note",
  });
  check("noah writes an outside note", outside.json?.ok === true);
  const said = await call("noah", "/v1/write", {
    source: "owner",
    evidence: `e2e:${RUN}:mensagem`,
    title: `${MARK} dito pelo dono`,
    body: "O dono disse uma preferência sintética.",
    kind: "preference",
  });
  check("noah writes what the owner said", said.json?.ok === true);
  const outsidePath = outside.json?.path ?? "";
  const saidPath = said.json?.path ?? "";

  // 3. A scheduled-routine context does not write.
  const cron = await call("noah", "/v1/write", {
    source: "owner",
    context: "cron",
    title: `${MARK} da rotina`,
    body: "Não deveria entrar.",
    kind: "note",
  });
  check("a scheduled routine does not write", cron.json?.reason === "cron");

  // 4. After the commit, noah sees both.
  check(
    "noah sees both after the commit",
    await until(
      90,
      async () => (await seen("noah", outsidePath)) && (await seen("noah", saidPath)),
    ),
  );

  // 5. alan does not see the outside note on any path, and sees what the owner said.
  check("alan does not read the outside note", !(await seen("alan", outsidePath)));
  check("alan does not find the outside note in search", !(await searched("alan", outsidePath)));
  check("alan does not get the outside note in recall", !(await recalled("alan", outsidePath)));
  check("alan does not see the outside note in pending", !(await pending("alan", outsidePath)));
  check("alan does not find the outside note over MCP", !(await mcpSearch("alan", outsidePath)));
  check("noah finds the outside note in search", await searched("noah", outsidePath));
  check("noah finds the outside note over MCP", await mcpSearch("noah", outsidePath));
  check("noah sees the outside note in pending", await pending("noah", outsidePath));
  check("alan reads what the owner said", await seen("alan", saidPath));
  check("outro does not see the outside note", !(await seen("outro", outsidePath)));

  // 6. The owner confirms the outside note on GitHub, removing the review: pending.
  const file = await github("GET", `contents/${outsidePath}`);
  const text = Buffer.from(file.content, "base64").toString("utf8");
  const confirmed = text.replace(/^ {2}review: pending\n/m, "");
  check("the outside note was pending", confirmed !== text);
  await github("PUT", `contents/${outsidePath}`, {
    message: "E2E: o dono confirma uma nota",
    content: Buffer.from(confirmed, "utf8").toString("base64"),
    sha: file.sha,
  });
  check(
    'the "yes" in the vault shows it to alan',
    await until(120, () => seen("alan", outsidePath)),
  );

  // 7. A note written on GitHub reaches the recall through the webhook.
  const ownersPath = `memory/notes/e2e-${RUN}-do-dono.md`;
  await github("PUT", `contents/${ownersPath}`, {
    message: "E2E: o dono escreve uma nota",
    content: Buffer.from(
      `# ${MARK} do dono\n\nNota sintética escrita direto no GitHub.\n`,
      "utf8",
    ).toString("base64"),
  });
  check(
    "the owner's edit reaches alan's recall",
    await until(120, () => recalled("alan", ownersPath)),
  );

  console.log(`\n${passed}/${passed + failures.length} passed (run ${RUN})`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`error: ${error instanceof Error ? error.message : "unknown"}`);
  process.exitCode = 1;
});
