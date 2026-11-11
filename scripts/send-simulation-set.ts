import { createHash } from "node:crypto";
import { access, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { authenticateDgii } from "../lib/dgii/authentication";
import { SIMULATION_EXPECTED_COUNTS } from "../lib/dgii/certification/simulation";
import {
  DgiiGatewayError,
  queryEcfResult,
  submitEcf,
} from "../lib/dgii/ecf/gateway";
import { StoredDgiiMessage, SubmissionStatus } from "../lib/dgii/ecf/submission-types";

type ManifestDocument = {
  order: number;
  phase: "simulation_submission" | "simulation_replacement" | "simulation_pending";
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

type Manifest = {
  purpose: string;
  sequenceStart?: number;
  expectedCounts?: Record<string, number>;
  parentPackage?: string;
  parentManifestSha256?: string;
  parentProgressSha256?: string;
  documents: ManifestDocument[];
};

type ProgressRecord = {
  caseId: string;
  encf: string;
  status: SubmissionStatus;
  trackId: string | null;
  httpStatus: number | null;
  officialStatus: string | null;
  sequenceUsed: boolean | null;
  messages: StoredDgiiMessage[];
  updatedAt: string;
};

type Progress = {
  environment: "certecf";
  purpose: "simulation" | "simulation_recovery";
  manifestSha256: string;
  records: Record<string, ProgressRecord>;
  updatedAt: string;
};

const workspace = process.cwd();
const generatedRoot = path.resolve("examples/certificacion/simulation/generated");
const submitEnabled = process.argv.includes("--submit");
const confirmedRnc = process.argv
  .find((value) => value.startsWith("--confirm-rnc="))
  ?.slice("--confirm-rnc=".length);
const positionalDirectory = process.argv.slice(2).find((value) => !value.startsWith("--"));

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Variavel ${name} ausente`);
  return value;
}

function ensureInsideWorkspace(target: string): void {
  const relative = path.relative(workspace, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("O diretorio do pacote deve estar dentro do projeto");
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function issuerRnc(document: ManifestDocument): string {
  if (!document.caseId.endsWith(document.encf)) {
    throw new Error(`caseId inconsistente no manifesto: ${document.caseId}`);
  }
  const rnc = document.caseId.slice(0, -document.encf.length);
  if (!/^(?:\d{9}|\d{11})$/.test(rnc)) {
    throw new Error(`RNC invalido no manifesto: ${document.caseId}`);
  }
  return rnc;
}

async function latestPackageDirectory(): Promise<string> {
  const entries = await readdir(generatedRoot, { withFileTypes: true });
  const name = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))[0];
  if (!name) throw new Error("Nenhum pacote de simulacao foi gerado");
  return path.join(generatedRoot, name);
}

function parseManifest(text: string): Manifest {
  const manifest = JSON.parse(text) as Manifest;
  const main = manifest?.purpose === "CerteCF - Paso 4 Pruebas Simulacion e-CF";
  const recovery = manifest?.purpose === "CerteCF - Paso 4 Recuperacion Simulacion e-CF";
  if ((!main && !recovery) || !Array.isArray(manifest.documents)) {
    throw new Error("manifest.json de simulacao invalido");
  }
  if (recovery) {
    if (
      manifest.documents.length < 1 ||
      !manifest.parentPackage ||
      !manifest.parentManifestSha256 ||
      !manifest.parentProgressSha256 ||
      manifest.documents.some((document) =>
        !["simulation_replacement", "simulation_pending"].includes(document.phase))
    ) {
      throw new Error("manifest.json de recuperacao invalido");
    }
    return manifest;
  }
  const expectedTotal = Object.values(SIMULATION_EXPECTED_COUNTS)
    .reduce((sum, count) => sum + count, 0);
  if (manifest.documents.length !== expectedTotal) {
    throw new Error(`O pacote deve conter exatamente ${expectedTotal} e-CF`);
  }
  for (const [type, expected] of Object.entries(SIMULATION_EXPECTED_COUNTS)) {
    const actual = manifest.documents.filter((document) => document.type === type).length;
    if (actual !== expected || manifest.expectedCounts?.[type] !== expected) {
      throw new Error(`Quantidade divergente para e-CF ${type}: ${actual}`);
    }
  }
  return manifest;
}

async function auditPackage(directory: string, manifest: Manifest): Promise<void> {
  const orders = new Set<number>();
  const encfs = new Set<string>();
  for (const document of manifest.documents) {
    if (orders.has(document.order)) throw new Error(`Ordem duplicada: ${document.order}`);
    if (encfs.has(document.encf)) throw new Error(`e-NCF duplicado: ${document.encf}`);
    orders.add(document.order);
    encfs.add(document.encf);
    if (
      !["simulation_submission", "simulation_replacement", "simulation_pending"]
        .includes(document.phase) ||
      document.kind !== "ECF" ||
      !document.xsdValidated ||
      !document.signatureVerified
    ) {
      throw new Error(`Documento de simulacao nao validado: ${document.caseId}`);
    }
    if (path.basename(document.fileName) !== document.fileName) {
      throw new Error(`Nome de arquivo inseguro: ${document.fileName}`);
    }
    const sequence = Number(document.encf.slice(3));
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 10_000_000) {
      throw new Error(`Sequencia fora da faixa de certificacao: ${document.encf}`);
    }
    const xml = await readFile(path.join(directory, "01-envio-ecf", document.fileName));
    if (sha256(xml) !== document.sha256) {
      throw new Error(`Hash divergente: ${document.caseId}`);
    }
  }

  if (manifest.parentPackage) {
    const parentDirectory = path.resolve(manifest.parentPackage);
    ensureInsideWorkspace(parentDirectory);
    const parentManifest = await readFile(path.join(parentDirectory, "manifest.json"));
    const parentProgress = await readFile(path.join(parentDirectory, "submission-progress.json"));
    if (
      sha256(parentManifest) !== manifest.parentManifestSha256 ||
      sha256(parentProgress) !== manifest.parentProgressSha256
    ) {
      throw new Error("O manifesto ou o progresso do pacote principal foi alterado");
    }
  }
}

async function readProgress(
  progressPath: string,
  manifestHash: string,
  purpose: Progress["purpose"],
): Promise<Progress> {
  try {
    const progress = JSON.parse(await readFile(progressPath, "utf8")) as Progress;
    if (
      progress.environment !== "certecf" ||
      progress.purpose !== purpose ||
      progress.manifestSha256 !== manifestHash
    ) {
      throw new Error("O progresso existente pertence a outro pacote ou ambiente");
    }
    return progress;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      environment: "certecf",
      purpose,
      manifestSha256: manifestHash,
      records: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

async function saveProgress(progressPath: string, progress: Progress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const temporary = `${progressPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(progress, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, progressPath);
}

function updateProgress(
  progress: Progress,
  document: ManifestDocument,
  patch: Omit<ProgressRecord, "caseId" | "encf" | "updatedAt">,
): void {
  progress.records[document.caseId] = {
    caseId: document.caseId,
    encf: document.encf,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForResult(
  document: ManifestDocument,
  token: string,
  trackId: string,
  progress: Progress,
  progressPath: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 45; attempt += 1) {
    const result = await queryEcfResult(trackId, token, "certecf");
    updateProgress(progress, document, {
      status: result.normalizedStatus,
      trackId,
      httpStatus: result.httpStatus,
      officialStatus: result.officialStatus,
      sequenceUsed: result.sequenceUsed,
      messages: result.messages,
    });
    await saveProgress(progressPath, progress);
    if (result.normalizedStatus === "accepted") return;
    if (
      result.normalizedStatus === "rejected" ||
      result.normalizedStatus === "accepted_conditional"
    ) {
      const details = result.messages.map((message) => message.value).join("; ");
      throw new Error(
        `${document.encf}: ${result.officialStatus ?? result.normalizedStatus}${details ? ` - ${details}` : ""}`,
      );
    }
    if (attempt < 45) await delay(2_000);
  }
  throw new Error(`${document.encf}: a DGII nao concluiu o processamento em 90 segundos`);
}

async function sendDocuments(
  packageDirectory: string,
  documents: ManifestDocument[],
  token: string,
  progress: Progress,
  progressPath: string,
): Promise<void> {
  for (const document of documents) {
    const existing = progress.records[document.caseId];
    if (existing?.status === "accepted") continue;
    if (existing?.status === "rejected" || existing?.status === "accepted_conditional") {
      throw new Error(`${document.encf}: tentativa anterior concluida como ${existing.status}`);
    }
    if (existing?.status === "indeterminate" && !existing.trackId) {
      throw new Error(
        `${document.encf}: envio anterior indeterminado; confira o portal antes de reenviar`,
      );
    }
    if (existing?.trackId) {
      await waitForResult(document, token, existing.trackId, progress, progressPath);
      continue;
    }

    const xml = await readFile(
      path.join(packageDirectory, "01-envio-ecf", document.fileName),
      "utf8",
    );
    try {
      const reception = await submitEcf({
        xml,
        issuerRnc: issuerRnc(document),
        encf: document.encf,
        token,
      }, "certecf");
      if (!reception.trackId) {
        throw new Error(
          `${document.encf}: recepcao sem TrackId (${reception.error ?? reception.message ?? "sem detalhe"})`,
        );
      }
      updateProgress(progress, document, {
        status: "received",
        trackId: reception.trackId,
        httpStatus: reception.httpStatus,
        officialStatus: reception.message,
        sequenceUsed: null,
        messages: reception.error ? [{ code: null, value: reception.error }] : [],
      });
      await saveProgress(progressPath, progress);
      await waitForResult(document, token, reception.trackId, progress, progressPath);
    } catch (error: unknown) {
      if (error instanceof DgiiGatewayError && error.afterPossibleReceipt) {
        updateProgress(progress, document, {
          status: "indeterminate",
          trackId: null,
          httpStatus: error.httpStatus,
          officialStatus: error.message,
          sequenceUsed: null,
          messages: [],
        });
        await saveProgress(progressPath, progress);
      }
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const packageDirectory = positionalDirectory
    ? path.resolve(positionalDirectory)
    : await latestPackageDirectory();
  ensureInsideWorkspace(packageDirectory);
  await access(path.join(packageDirectory, "manifest.json"));
  const manifestText = await readFile(path.join(packageDirectory, "manifest.json"), "utf8");
  const manifest = parseManifest(manifestText);
  await auditPackage(packageDirectory, manifest);
  const documents = [...manifest.documents].sort((left, right) => left.order - right.order);
  const rncs = [...new Set(documents.map(issuerRnc))];
  if (rncs.length !== 1) throw new Error("O pacote possui mais de um RNC emissor");
  const rnc = rncs[0]!;

  if (!submitEnabled) {
    console.log(JSON.stringify({
      success: true,
      mode: "audit_only",
      environment: "certecf",
      packageDirectory: path.relative(workspace, packageDirectory).replace(/\\/g, "/"),
      rnc,
      ready: documents.length,
      countsByType: Object.fromEntries(
        Object.keys(SIMULATION_EXPECTED_COUNTS).map((type) => [
          type,
          documents.filter((document) => document.type === type).length,
        ]),
      ),
      nextCommand:
        `npm run certification:simulation:send -- "${path.relative(workspace, packageDirectory).replace(/\\/g, "/")}" --submit --confirm-rnc=${rnc}`,
    }, null, 2));
    return;
  }
  if (confirmedRnc !== rnc) throw new Error(`Confirme o RNC com --confirm-rnc=${rnc}`);

  const progressPath = path.join(packageDirectory, "submission-progress.json");
  const progressPurpose = manifest.purpose.includes("Recuperacion")
    ? "simulation_recovery"
    : "simulation";
  const progress = await readProgress(progressPath, sha256(manifestText), progressPurpose);
  const authentication = await authenticateDgii({
    p12Base64: requiredEnvironment("DGII_CERT_P12_BASE64"),
    certificatePassword: process.env.DGII_CERT_PASSWORD ?? "",
    environment: "certecf",
    requestTimeoutMs: 30_000,
  });
  await sendDocuments(packageDirectory, documents, authentication.token, progress, progressPath);

  console.log(JSON.stringify({
    success: true,
    environment: "certecf",
    acceptedSimulationDocuments: documents.length,
    packageDirectory: path.relative(workspace, packageDirectory).replace(/\\/g, "/"),
  }, null, 2));
}

main().catch((error: unknown) => {
  const gatewayError = error instanceof DgiiGatewayError ? error : null;
  console.error(JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : "Falha desconhecida",
    stage: gatewayError?.stage ?? null,
    type: gatewayError?.type ?? null,
    httpStatus: gatewayError?.httpStatus ?? null,
    afterPossibleReceipt: gatewayError?.afterPossibleReceipt ?? null,
    retrySafety: gatewayError ? !gatewayError.afterPossibleReceipt : null,
  }, null, 2));
  process.exitCode = 1;
});
