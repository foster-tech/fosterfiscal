import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MANIFEST_PATH = path.resolve(
  "output/ecf/production/2026-11-11-encf-8-9/manifest.json",
);
const RESULTS_PATH = path.resolve(
  "output/ecf/production/2026-11-11-encf-8-9/send-results.json",
);
const ENDPOINT =
  process.env.DGII_PRODUCTION_PROXY_URL ??
  "https://fosterfiscal.vercel.app/api/dgii/ecf/send-production";
const ISSUER_RNC = "132071506";

type ManifestEntry = {
  buyer: string;
  buyerRnc: string;
  encf: string;
  output: string;
  sha256: string;
  signed: boolean;
  transmitted: boolean;
};

type Manifest = {
  environment: string;
  issuerRnc: string;
  submittedToDgii: boolean;
  invoices: ManifestEntry[];
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel ${name} ausente`);
  return value;
}

function argumentValue(prefix: string): string | null {
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length) ?? null;
}

async function requestProduction(
  entry: ManifestEntry,
  xml: string,
  operation: "preflight" | "submit",
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dgii-test-token": requiredEnvironment("DGII_TEST_TOKEN"),
      },
      body: JSON.stringify({
        operation,
        confirmRnc: ISSUER_RNC,
        confirmEncf: entry.encf,
        confirmation:
          operation === "submit"
            ? `SEND ${entry.encf} TO DGII PRODUCTION`
            : null,
        xmlBase64: Buffer.from(xml, "utf8").toString("base64"),
        sha256: entry.sha256,
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { success: false, diagnostic: { message: "Resposta sem JSON" } };
    }
    return { httpStatus: response.status, ...body };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const submit = process.argv.includes("--submit");
  const confirmRnc = argumentValue("--confirm-rnc=");
  if (submit && confirmRnc !== ISSUER_RNC) {
    throw new Error(`Use --confirm-rnc=${ISSUER_RNC} para autorizar producao`);
  }

  const manifest = JSON.parse(
    await readFile(MANIFEST_PATH, "utf8"),
  ) as Manifest;
  if (manifest.environment !== "ecf" || manifest.issuerRnc !== ISSUER_RNC) {
    throw new Error("Manifesto nao corresponde ao emissor/ambiente de producao");
  }
  if (manifest.invoices.length !== 2) {
    throw new Error("Esta operacao autoriza exatamente duas faturas");
  }

  const operation = submit ? "submit" : "preflight";
  const results = [];
  for (const entry of manifest.invoices) {
    if (!entry.signed) throw new Error(`${entry.encf}: XML nao marcado como assinado`);
    const xml = await readFile(entry.output, "utf8");
    const digest = createHash("sha256").update(xml, "utf8").digest("hex");
    if (digest !== entry.sha256) {
      throw new Error(`${entry.encf}: SHA-256 difere do manifesto`);
    }

    const response = await requestProduction(entry, xml, operation);
    results.push({
      buyer: entry.buyer,
      buyerRnc: entry.buyerRnc,
      encf: entry.encf,
      sha256: entry.sha256,
      response,
    });

    if (response.success !== true) {
      break;
    }
  }

  const output = {
    timestamp: new Date().toISOString(),
    endpoint: ENDPOINT,
    environment: "ecf",
    operation,
    issuerRnc: ISSUER_RNC,
    results,
  };
  await writeFile(RESULTS_PATH, JSON.stringify(output, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify(output, null, 2));

  if (results.length !== manifest.invoices.length) process.exitCode = 2;
  if (results.some((entry) => entry.response.success !== true)) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : "Falha desconhecida",
  }));
  process.exitCode = 1;
});
