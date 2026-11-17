import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MANIFEST_PATH = path.resolve(
  "output/ecf/production/2026-11-17-claro-encf-10/manifest.json",
);
const OUTPUT_DIR = path.dirname(MANIFEST_PATH);
const ENDPOINT =
  process.env.DGII_PRODUCTION_PROXY_URL ??
  "https://fosterfiscal.vercel.app/api/dgii/ecf/send-production";
const ISSUER_RNC = "132071506";
const ENCF = "E310000000010";

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
        confirmEncf: ENCF,
        confirmation:
          operation === "submit" ? `SEND ${ENCF} TO DGII PRODUCTION` : null,
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
      body = {
        success: false,
        diagnostic: { message: "Resposta sem JSON", preview: text.slice(0, 500) },
      };
    }
    return { httpStatus: response.status, ...body };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const operation = process.argv.includes("--submit") ? "submit" : "preflight";
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Manifest;
  if (
    manifest.environment !== "ecf" ||
    manifest.issuerRnc !== ISSUER_RNC ||
    manifest.invoices.length !== 1
  ) {
    throw new Error("Manifesto nao corresponde a fatura unica autorizada");
  }

  const entry = manifest.invoices[0];
  if (
    entry.encf !== ENCF ||
    entry.buyerRnc !== "101001577" ||
    !entry.signed ||
    entry.transmitted
  ) {
    throw new Error("Identidade ou estado da fatura nao corresponde a autorizacao");
  }

  const xml = await readFile(entry.output, "utf8");
  const digest = createHash("sha256").update(xml, "utf8").digest("hex");
  if (digest !== entry.sha256) throw new Error("SHA-256 difere do manifesto");

  const response = await requestProduction(entry, xml, operation);
  const result = {
    timestamp: new Date().toISOString(),
    endpoint: ENDPOINT,
    environment: "ecf",
    operation,
    issuerRnc: ISSUER_RNC,
    buyer: entry.buyer,
    buyerRnc: entry.buyerRnc,
    encf: entry.encf,
    sha256: entry.sha256,
    response,
  };
  const resultPath = path.join(
    OUTPUT_DIR,
    operation === "submit" ? "send-results.json" : "preflight-results.json",
  );
  await writeFile(resultPath, JSON.stringify(result, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify(result, null, 2));

  if (response.success !== true) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Falha desconhecida",
    }),
  );
  process.exitCode = 1;
});
