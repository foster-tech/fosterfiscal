import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { prepareCertificationSet } from "../lib/dgii/certification/prepare";
import { buildSimulationWorkbook } from "../lib/dgii/certification/simulation";
import { parseCertificationWorkbook } from "../lib/dgii/certification/xlsx";
import { loadSigningMaterial } from "../lib/dgii/xml-signature";

type ParentDocument = {
  order: number;
  kind: "ECF";
  type: string;
  caseId: string;
  encf: string;
  previousEncf: string | null;
  fileName: string;
  sha256: string;
  schema: string;
  xsdValidated: boolean;
  signatureVerified: boolean;
};

type ParentManifest = {
  purpose: string;
  source: string;
  documents: ParentDocument[];
};

type ParentProgressRecord = {
  caseId: string;
  encf: string;
  status: string;
  sequenceUsed: boolean | null;
};

type ParentProgress = {
  records: Record<string, ParentProgressRecord>;
};

const workspace = process.cwd();
const generatedRoot = path.resolve("examples/certificacion/simulation/generated");
const recoveryRoot = path.resolve("examples/certificacion/simulation/recovery/generated");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = path.join(recoveryRoot, timestamp);
const positionalParent = process.argv.slice(2).find((value) => !value.startsWith("--"));
const alcoholSpecificTaxRate = process.argv
  .find((value) => value.startsWith("--alcohol-specific-rate="))
  ?.slice("--alcohol-specific-rate=".length) ?? "768.65";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Variavel ${name} ausente`);
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensureInsideWorkspace(target: string): void {
  const relative = path.relative(workspace, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("O pacote deve estar dentro do projeto");
  }
}

async function latestParentDirectory(): Promise<string> {
  const name = (await readdir(generatedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))[0];
  if (!name) throw new Error("Nenhum pacote principal de simulacao encontrado");
  return path.join(generatedRoot, name);
}

async function main(): Promise<void> {
  const parentDirectory = positionalParent
    ? path.resolve(positionalParent)
    : await latestParentDirectory();
  ensureInsideWorkspace(parentDirectory);
  ensureInsideWorkspace(outputDirectory);
  const parentManifestText = await readFile(path.join(parentDirectory, "manifest.json"), "utf8");
  const parentProgressText = await readFile(
    path.join(parentDirectory, "submission-progress.json"),
    "utf8",
  );
  const parentManifest = JSON.parse(parentManifestText) as ParentManifest;
  const parentProgress = JSON.parse(parentProgressText) as ParentProgress;
  const mainPackage = parentManifest.purpose ===
    "CerteCF - Paso 4 Pruebas Simulacion e-CF";
  const recoveryPackage = parentManifest.purpose ===
    "CerteCF - Paso 4 Recuperacion Simulacion e-CF";
  if ((!mainPackage && !recoveryPackage) || !Array.isArray(parentManifest.documents) ||
    !parentProgress?.records) {
    throw new Error("Pacote principal ou progresso invalido");
  }
  const attempts = Object.values(parentProgress.records);
  const accepted = attempts.filter((record) => record.status === "accepted");
  const rejected = attempts.filter((record) => record.status === "rejected");
  const unsafe = attempts.filter((record) =>
    !["accepted", "rejected"].includes(record.status));
  const expectedAccepted = mainPackage ? 13 : 0;
  if (accepted.length !== expectedAccepted || rejected.length !== 1 || unsafe.length) {
    throw new Error(
      `Estado inesperado: ${accepted.length} aceitos, ${rejected.length} rejeitados, ${unsafe.length} pendentes`,
    );
  }
  const rejectedRecord = rejected[0]!;
  if (rejectedRecord.sequenceUsed !== true) {
    throw new Error("A DGII nao confirmou o consumo da sequencia rejeitada");
  }
  const rejectedDocument = parentManifest.documents.find(
    (document) => document.caseId === rejectedRecord.caseId,
  );
  if (!rejectedDocument || rejectedDocument.type !== "45" || !rejectedDocument.previousEncf) {
    throw new Error("O documento rejeitado nao corresponde ao E45 esperado");
  }

  const pendingDocuments = parentManifest.documents
    .filter((document) => !parentProgress.records[document.caseId])
    .sort((left, right) => left.order - right.order);
  if (pendingDocuments.length !== 7) {
    throw new Error(`Esperados 7 documentos ainda nao enviados; encontrados ${pendingDocuments.length}`);
  }
  for (const document of pendingDocuments) {
    const xml = await readFile(path.join(parentDirectory, "01-envio-ecf", document.fileName));
    if (sha256(xml) !== document.sha256) throw new Error(`Hash divergente: ${document.caseId}`);
  }

  const sourcePath = path.resolve(parentManifest.source);
  ensureInsideWorkspace(sourcePath);
  const sourceWorkbook = parseCertificationWorkbook(await readFile(sourcePath));
  const replacementSourceEncf = recoveryPackage
    ? "E450000000009"
    : rejectedDocument.previousEncf;
  const replacementSequenceStart = recoveryPackage ? 9_000_004 : 9_000_002;
  const expectedReplacementEncf = recoveryPackage
    ? "E450009000004"
    : "E450009000003";
  const transformed = buildSimulationWorkbook(sourceWorkbook, {
    sequenceStart: replacementSequenceStart,
    alcoholSpecificTaxRate,
  });
  const replacementMapping = transformed.identityMapping.find(
    (mapping) => mapping.previousEncf === replacementSourceEncf,
  );
  if (!replacementMapping || replacementMapping.encf !== expectedReplacementEncf) {
    throw new Error(`Nao foi possivel reservar a nova sequencia ${expectedReplacementEncf}`);
  }
  const ecfSheet = transformed.workbook.sheets.get("ECF");
  if (!ecfSheet) throw new Error("Aba ECF transformada ausente");
  const replacementRow = ecfSheet.rows.find(
    (row) => row.ENCF === replacementMapping.encf,
  );
  if (!replacementRow) throw new Error("Linha de substituicao ausente");
  const recoverySheets = new Map(transformed.workbook.sheets);
  recoverySheets.set("ECF", { ...ecfSheet, rows: [replacementRow] });
  const material = await loadSigningMaterial(
    requiredEnvironment("DGII_CERT_P12_BASE64"),
    process.env.DGII_CERT_PASSWORD ?? "",
  );
  const replacementSet = await prepareCertificationSet({ sheets: recoverySheets }, material);
  if (
    replacementSet.directSubmissions.length !== 1 ||
    replacementSet.summarySubmissions.length ||
    replacementSet.manualPortalUploads.length
  ) {
    throw new Error("A recuperacao deve gerar exatamente um E45 substituto");
  }
  const replacement = replacementSet.directSubmissions[0]!;

  const documentDirectory = path.join(outputDirectory, "01-envio-ecf");
  await mkdir(documentDirectory, { recursive: true });
  await writeFile(path.join(documentDirectory, replacement.fileName), replacement.xml, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  for (const document of pendingDocuments) {
    await copyFile(
      path.join(parentDirectory, "01-envio-ecf", document.fileName),
      path.join(documentDirectory, document.fileName),
    );
  }

  const documents = [
    {
      order: 1,
      phase: "simulation_replacement" as const,
      kind: replacement.kind,
      type: replacement.type,
      caseId: replacement.caseId,
      encf: replacement.encf,
      previousEncf: replacementSourceEncf,
      replacesEncf: rejectedDocument.encf,
      fileName: replacement.fileName,
      sha256: replacement.sha256,
      schema: replacement.schema.fileName,
      xsdValidated: true,
      signatureVerified: true,
    },
    ...pendingDocuments.map((document, index) => ({
      ...document,
      order: index + 2,
      phase: "simulation_pending" as const,
      replacesEncf: null,
    })),
  ];
  const manifest = {
    generatedAt: new Date().toISOString(),
    purpose: "CerteCF - Paso 4 Recuperacion Simulacion e-CF",
    source: parentManifest.source,
    alcoholSpecificTaxRate,
    parentPackage: path.relative(workspace, parentDirectory).replace(/\\/g, "/"),
    parentManifestSha256: sha256(parentManifestText),
    parentProgressSha256: sha256(parentProgressText),
    priorOutcome: { accepted: accepted.length, rejected: rejected.length },
    documents,
  };
  await writeFile(
    path.join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );

  console.log(JSON.stringify({
    success: true,
    mode: "simulation_recovery_prepare",
    outputDirectory: path.relative(workspace, outputDirectory).replace(/\\/g, "/"),
    priorAccepted: accepted.length,
    replacedRejectedEncf: rejectedDocument.encf,
    replacementEncf: replacement.encf,
    pendingCarriedForward: pendingDocuments.length,
    ready: documents.length,
    alcoholSpecificTaxRate,
    replacementXsdValidated: true,
    replacementSignatureVerified: true,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : "Falha desconhecida",
  }, null, 2));
  process.exitCode = 1;
});
