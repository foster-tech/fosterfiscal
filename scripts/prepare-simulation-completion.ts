import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PreparedCertificationDocument } from "../lib/dgii/certification/prepare";
import { prepareSimulationCompletionSet } from "../lib/dgii/certification/simulation";
import { parseCertificationWorkbook } from "../lib/dgii/certification/xlsx";
import { loadSigningMaterial } from "../lib/dgii/xml-signature";

const workspace = process.cwd();
const inputPath = path.resolve(
  process.argv.slice(2).find((value) => !value.startsWith("--")) ??
    "examples/certificacion/comprobantes.xlsx",
);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = path.resolve(
  `examples/certificacion/simulation/completion/generated/${timestamp}`,
);
const sequenceStart = Number(
  process.argv.find((value) => value.startsWith("--sequence-start="))
    ?.slice("--sequence-start=".length) ?? "9000101",
);
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

async function writeDocuments(
  directory: string,
  documents: PreparedCertificationDocument[],
): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const document of documents) {
    await writeFile(path.join(directory, document.fileName), document.xml, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
}

async function main(): Promise<void> {
  assertWorkspacePath(inputPath, "O XLSX de entrada");
  assertWorkspacePath(outputDirectory, "O diretorio de saida");
  if (!Number.isSafeInteger(sequenceStart) || sequenceStart < 1 || sequenceStart > 9_999_997) {
    throw new Error("--sequence-start deve estar entre 1 e 9.999.997");
  }
  const workbook = parseCertificationWorkbook(await readFile(inputPath));
  const material = await loadSigningMaterial(
    requiredEnvironment("DGII_CERT_P12_BASE64"),
    process.env.DGII_CERT_PASSWORD ?? "",
  );
  const result = await prepareSimulationCompletionSet(workbook, material, {
    sequenceStart,
    alcoholSpecificTaxRate,
  });
  const prepared = result.prepared;
  await writeDocuments(
    path.join(outputDirectory, "01-envio-ecf"),
    prepared.directSubmissions,
  );
  await writeDocuments(
    path.join(outputDirectory, "02-resumos-rfce"),
    prepared.summarySubmissions,
  );
  await writeDocuments(
    path.join(outputDirectory, "03-upload-manual-ecf32"),
    prepared.manualPortalUploads,
  );

  const documents = [
    ...prepared.directSubmissions,
    ...prepared.summarySubmissions,
    ...prepared.manualPortalUploads,
  ];
  const manifest = {
    generatedAt: new Date().toISOString(),
    purpose: "CerteCF - Paso 4 Complemento Pruebas Simulacion e-CF",
    source: path.relative(workspace, inputPath).replace(/\\/g, "/"),
    sequenceStart,
    issueDate: result.issueDate,
    sequenceExpirationDate: result.sequenceExpirationDate,
    alcoholSpecificTaxRate,
    signatureProfile: "RSA-SHA256 / SHA-256 / C14N 1.0 enveloped",
    counts: {
      directSubmissions: prepared.directSubmissions.length,
      summarySubmissions: prepared.summarySubmissions.length,
      manualPortalUploads: prepared.manualPortalUploads.length,
    },
    documents: documents.map((document, index) => ({
      order: index + 1,
      phase: document.phase,
      kind: document.kind,
      type: document.type,
      caseId: document.caseId,
      encf: document.encf,
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
    mode: "simulation_completion_prepare",
    outputDirectory: path.relative(workspace, outputDirectory).replace(/\\/g, "/"),
    sequenceStart,
    issueDate: result.issueDate,
    counts: manifest.counts,
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
