import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  prepareSimulationSet,
  SIMULATION_EXPECTED_COUNTS,
} from "../lib/dgii/certification/simulation";
import { parseCertificationWorkbook } from "../lib/dgii/certification/xlsx";
import { loadSigningMaterial } from "../lib/dgii/xml-signature";

const workspace = process.cwd();
const inputPath = path.resolve(
  process.argv.slice(2).find((value) => !value.startsWith("--")) ??
    "examples/certificacion/comprobantes.xlsx",
);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = path.resolve(
  `examples/certificacion/simulation/generated/${timestamp}`,
);
const sequenceStartValue = process.argv
  .find((value) => value.startsWith("--sequence-start="))
  ?.slice("--sequence-start=".length) ?? "9000001";
const sequenceStart = Number(sequenceStartValue);
const alcoholSpecificTaxRate = process.argv
  .find((value) => value.startsWith("--alcohol-specific-rate="))
  ?.slice("--alcohol-specific-rate=".length) ?? "768.65";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Variavel ${name} ausente`);
  return value;
}

function assertWorkspacePath(target: string, label: string): void {
  const relative = path.relative(workspace, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} deve estar dentro do projeto`);
  }
}

async function main(): Promise<void> {
  assertWorkspacePath(inputPath, "O XLSX de entrada");
  assertWorkspacePath(outputDirectory, "O diretorio de saida");
  if (!Number.isSafeInteger(sequenceStart) || sequenceStart < 1 || sequenceStart > 9_999_999) {
    throw new Error("--sequence-start deve estar entre 1 e 9.999.999");
  }

  const workbook = parseCertificationWorkbook(await readFile(inputPath));
  const material = await loadSigningMaterial(
    requiredEnvironment("DGII_CERT_P12_BASE64"),
    process.env.DGII_CERT_PASSWORD ?? "",
  );
  const prepared = await prepareSimulationSet(workbook, material, {
    sequenceStart,
    alcoholSpecificTaxRate,
  });

  const documentDirectory = path.join(outputDirectory, "01-envio-ecf");
  await mkdir(documentDirectory, { recursive: true });
  for (const document of prepared.documents) {
    await writeFile(path.join(documentDirectory, document.fileName), document.xml, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }

  const mappingByEncf = new Map(
    prepared.identityMapping.map((mapping) => [mapping.encf, mapping]),
  );
  const manifest = {
    generatedAt: new Date().toISOString(),
    purpose: "CerteCF - Paso 4 Pruebas Simulacion e-CF",
    source: path.relative(workspace, inputPath).replace(/\\/g, "/"),
    sequenceStart,
    alcoholSpecificTaxRate,
    issueDate: prepared.issueDate,
    sequenceExpirationDate: prepared.sequenceExpirationDate,
    expectedCounts: SIMULATION_EXPECTED_COUNTS,
    signatureProfile: "RSA-SHA256 / SHA-256 / C14N 1.0 enveloped",
    documents: prepared.documents.map((document, index) => ({
      order: index + 1,
      phase: "simulation_submission" as const,
      kind: document.kind,
      type: document.type,
      caseId: document.caseId,
      encf: document.encf,
      previousEncf: mappingByEncf.get(document.encf)?.previousEncf ?? null,
      fileName: document.fileName,
      sha256: document.sha256,
      schema: document.schema.fileName,
      xsdValidated: true,
      signatureVerified: true,
    })),
  };
  await writeFile(
    path.join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );

  console.log(JSON.stringify({
    success: true,
    mode: "simulation_prepare",
    outputDirectory: path.relative(workspace, outputDirectory).replace(/\\/g, "/"),
    issueDate: prepared.issueDate,
    sequenceStart,
    alcoholSpecificTaxRate,
    count: prepared.documents.length,
    countsByType: Object.fromEntries(
      Object.keys(SIMULATION_EXPECTED_COUNTS).map((type) => [
        type,
        prepared.documents.filter((document) => document.type === type).length,
      ]),
    ),
    allXsdValidated: true,
    allSignaturesVerified: true,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : "Falha desconhecida",
  }, null, 2));
  process.exitCode = 1;
});
