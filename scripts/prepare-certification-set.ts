import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CertificationPreparationError,
  prepareCertificationSet,
  PreparedCertificationDocument,
} from "../lib/dgii/certification/prepare";
import { parseCertificationWorkbook } from "../lib/dgii/certification/xlsx";
import { loadSigningMaterial } from "../lib/dgii/xml-signature";

const workspace = process.cwd();
const inputPath = path.resolve(
  process.argv[2] ?? "examples/certificacion/comprobantes.xlsx",
);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = path.resolve(
  process.argv[3] ?? `examples/certificacion/generated/${timestamp}`,
);

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
  if (path.extname(inputPath).toLocaleLowerCase("en-US") !== ".xlsx") {
    throw new Error("O arquivo de entrada deve possuir extensao .xlsx");
  }

  const workbook = parseCertificationWorkbook(await readFile(inputPath));
  const material = await loadSigningMaterial(
    requiredEnvironment("DGII_CERT_P12_BASE64"),
    process.env.DGII_CERT_PASSWORD ?? "",
  );
  const prepared = await prepareCertificationSet(workbook, material);

  await writeDocuments(
    path.join(outputDirectory, "01-envio-direto"),
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

  const allDocuments = [
    ...prepared.directSubmissions,
    ...prepared.summarySubmissions,
    ...prepared.manualPortalUploads,
  ];
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: path.relative(workspace, inputPath).replace(/\\/g, "/"),
    signatureProfile: "RSA-SHA256 / SHA-256 / C14N 1.0 enveloped",
    counts: {
      directSubmissions: prepared.directSubmissions.length,
      summarySubmissions: prepared.summarySubmissions.length,
      manualPortalUploads: prepared.manualPortalUploads.length,
    },
    documents: allDocuments.map((document, index) => ({
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
    outputDirectory: path.relative(workspace, outputDirectory).replace(/\\/g, "/"),
    counts: manifest.counts,
    allXsdValidated: true,
    allSignaturesVerified: true,
  }, null, 2));
}

main().catch((error: unknown) => {
  const preparation = error instanceof CertificationPreparationError ? error : null;
  console.error(JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : "Falha desconhecida",
    caseId: preparation?.caseId ?? null,
    xsdErrors: preparation?.xsdErrors ?? [],
  }, null, 2));
  process.exitCode = 1;
});
