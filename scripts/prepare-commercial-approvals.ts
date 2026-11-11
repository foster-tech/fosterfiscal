import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CommercialApprovalPreparationError,
  prepareCommercialApprovals,
} from "../lib/dgii/certification/commercial-approval";
import { parseCertificationWorkbook } from "../lib/dgii/certification/xlsx";
import { loadSigningMaterial } from "../lib/dgii/xml-signature";

const workspace = process.cwd();
const inputPath = path.resolve(process.argv[2] ?? "examples/certificacion/aprobacion-comercial.xlsx");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = path.resolve(
  process.argv[3] ?? `examples/certificacion/approvals/generated/${timestamp}`,
);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Variavel ${name} ausente`);
  return value;
}

function assertOutputInsideWorkspace(target: string): void {
  const relative = path.relative(workspace, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("O diretorio de saida deve estar dentro do projeto");
  }
}

async function main(): Promise<void> {
  assertOutputInsideWorkspace(outputDirectory);
  if (path.extname(inputPath).toLocaleLowerCase("en-US") !== ".xlsx") {
    throw new Error("O arquivo de entrada deve possuir extensao .xlsx");
  }
  const workbookBytes = await readFile(inputPath);
  const workbook = parseCertificationWorkbook(workbookBytes);
  const material = await loadSigningMaterial(
    requiredEnvironment("DGII_CERT_P12_BASE64"),
    process.env.DGII_CERT_PASSWORD ?? "",
  );
  const documents = await prepareCommercialApprovals(workbook, material);
  await mkdir(outputDirectory, { recursive: true });
  for (const document of documents) {
    await writeFile(path.join(outputDirectory, document.fileName), document.xml, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceFileName: path.basename(inputPath),
    sourceSha256: createHash("sha256").update(workbookBytes).digest("hex"),
    signatureProfile: "RSA-SHA256 / SHA-256 / C14N 1.0 enveloped",
    count: documents.length,
    documents: documents.map((document) => ({
      order: document.order,
      caseId: document.caseId,
      issuerRnc: document.issuerRnc,
      buyerRnc: document.buyerRnc,
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
    outputDirectory: path.relative(workspace, outputDirectory).replace(/\\/g, "/"),
    count: documents.length,
    allXsdValidated: true,
    allSignaturesVerified: true,
  }, null, 2));
}

main().catch((error: unknown) => {
  const preparation = error instanceof CommercialApprovalPreparationError ? error : null;
  console.error(JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : "Falha desconhecida",
    caseId: preparation?.caseId ?? null,
    xsdErrors: preparation?.xsdErrors ?? [],
  }, null, 2));
  process.exitCode = 1;
});
