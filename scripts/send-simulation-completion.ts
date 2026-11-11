import { createHash } from "node:crypto";
import { access, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { authenticateDgii } from "../lib/dgii/authentication";
import { submitRfceCertification } from "../lib/dgii/certification/gateway";
import { DgiiGatewayError, queryEcfResult, submitEcf } from "../lib/dgii/ecf/gateway";
import { StoredDgiiMessage, SubmissionStatus } from "../lib/dgii/ecf/submission-types";

type Phase = "direct_submission" | "summary_submission" | "manual_portal_upload";
type ManifestDocument = {
  order: number;
  phase: Phase;
  kind: "ECF" | "RFCE";
  type: string;
  caseId: string;
  encf: string;
  fileName: string;
  sha256: string;
  schema: string;
  xsdValidated: boolean;
  signatureVerified: boolean;
};
type Manifest = {
  purpose: string;
  counts: {
    directSubmissions: number;
    summarySubmissions: number;
    manualPortalUploads: number;
  };
  documents: ManifestDocument[];
};
type ProgressRecord = {
  phase: Exclude<Phase, "manual_portal_upload">;
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
  purpose: "simulation_completion";
  manifestSha256: string;
  records: Record<string, ProgressRecord>;
  updatedAt: string;
};

const workspace = process.cwd();
const generatedRoot = path.resolve("examples/certificacion/simulation/completion/generated");
const submitEnabled = process.argv.includes("--submit");
const confirmedRnc = process.argv.find((value) => value.startsWith("--confirm-rnc="))
  ?.slice("--confirm-rnc=".length);
const positionalDirectory = process.argv.slice(2).find((value) => !value.startsWith("--"));

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel ${name} ausente`);
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
function recordKey(document: ManifestDocument): string {
  return `${document.phase}:${document.caseId}`;
}
function directoryFor(phase: Phase): string {
  if (phase === "direct_submission") return "01-envio-ecf";
  if (phase === "summary_submission") return "02-resumos-rfce";
  return "03-upload-manual-ecf32";
}
function issuerRnc(document: ManifestDocument): string {
  if (!document.caseId.endsWith(document.encf)) {
    throw new Error(`caseId inconsistente: ${document.caseId}`);
  }
  const rnc = document.caseId.slice(0, -document.encf.length);
  if (!/^(?:\d{9}|\d{11})$/.test(rnc)) throw new Error(`RNC invalido: ${rnc}`);
  return rnc;
}
async function latestPackageDirectory(): Promise<string> {
  const name = (await readdir(generatedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))[0];
  if (!name) throw new Error("Nenhum pacote complementar foi gerado");
  return path.join(generatedRoot, name);
}
function parseManifest(text: string): Manifest {
  const manifest = JSON.parse(text) as Manifest;
  if (
    manifest?.purpose !== "CerteCF - Paso 4 Complemento Pruebas Simulacion e-CF" ||
    !Array.isArray(manifest.documents) ||
    manifest.counts?.directSubmissions !== 13 ||
    manifest.counts?.summarySubmissions !== 4 ||
    manifest.counts?.manualPortalUploads !== 4 ||
    manifest.documents.length !== 21
  ) {
    throw new Error("manifest.json complementar invalido");
  }
  return manifest;
}
async function auditPackage(directory: string, manifest: Manifest): Promise<void> {
  const orders = new Set<number>();
  for (const document of manifest.documents) {
    if (orders.has(document.order)) throw new Error(`Ordem duplicada: ${document.order}`);
    orders.add(document.order);
    if (path.basename(document.fileName) !== document.fileName) {
      throw new Error(`Nome inseguro: ${document.fileName}`);
    }
    if (!document.xsdValidated || !document.signatureVerified) {
      throw new Error(`Documento nao validado: ${document.caseId}`);
    }
    const xml = await readFile(
      path.join(directory, directoryFor(document.phase), document.fileName),
    );
    if (sha256(xml) !== document.sha256) throw new Error(`Hash divergente: ${document.caseId}`);
  }
}
async function readProgress(progressPath: string, manifestHash: string): Promise<Progress> {
  try {
    const progress = JSON.parse(await readFile(progressPath, "utf8")) as Progress;
    if (
      progress.environment !== "certecf" ||
      progress.purpose !== "simulation_completion" ||
      progress.manifestSha256 !== manifestHash
    ) {
      throw new Error("O progresso pertence a outro pacote ou ambiente");
    }
    return progress;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      environment: "certecf",
      purpose: "simulation_completion",
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
  patch: Omit<ProgressRecord, "phase" | "caseId" | "encf" | "updatedAt">,
): void {
  if (document.phase === "manual_portal_upload") throw new Error("Upload manual inesperado");
  progress.records[recordKey(document)] = {
    phase: document.phase,
    caseId: document.caseId,
    encf: document.encf,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function waitForDirectResult(
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
    if (["rejected", "accepted_conditional"].includes(result.normalizedStatus)) {
      const detail = result.messages.map((message) => message.value).join("; ");
      throw new Error(`${document.encf}: ${result.officialStatus ?? result.normalizedStatus}${detail ? ` - ${detail}` : ""}`);
    }
    if (attempt < 45) await delay(2_000);
  }
  throw new Error(`${document.encf}: processamento nao concluido em 90 segundos`);
}
async function sendDirect(
  directory: string,
  documents: ManifestDocument[],
  token: string,
  progress: Progress,
  progressPath: string,
): Promise<void> {
  for (const document of documents) {
    const existing = progress.records[recordKey(document)];
    if (existing?.status === "accepted") continue;
    if (existing?.status === "rejected" || existing?.status === "accepted_conditional") {
      throw new Error(`${document.encf}: tentativa anterior concluida como ${existing.status}`);
    }
    if (existing?.status === "indeterminate" && !existing.trackId) {
      throw new Error(`${document.encf}: envio anterior indeterminado; confira o portal`);
    }
    if (existing?.trackId) {
      await waitForDirectResult(document, token, existing.trackId, progress, progressPath);
      continue;
    }
    const xml = await readFile(path.join(directory, "01-envio-ecf", document.fileName), "utf8");
    try {
      const reception = await submitEcf({
        xml,
        issuerRnc: issuerRnc(document),
        encf: document.encf,
        token,
      }, "certecf");
      if (!reception.trackId) {
        throw new Error(`${document.encf}: recepcao sem TrackId`);
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
      await waitForDirectResult(document, token, reception.trackId, progress, progressPath);
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
async function sendSummaries(
  directory: string,
  documents: ManifestDocument[],
  token: string,
  progress: Progress,
  progressPath: string,
): Promise<void> {
  for (const document of documents) {
    const existing = progress.records[recordKey(document)];
    if (existing?.status === "accepted") continue;
    if (existing) throw new Error(`${document.encf}: RFCE ja possui tentativa registrada`);
    const xml = await readFile(path.join(directory, "02-resumos-rfce", document.fileName), "utf8");
    try {
      const result = await submitRfceCertification({
        xml,
        issuerRnc: issuerRnc(document),
        encf: document.encf,
        token,
      });
      updateProgress(progress, document, {
        status: result.normalizedStatus,
        trackId: null,
        httpStatus: result.httpStatus,
        officialStatus: result.officialStatus,
        sequenceUsed: null,
        messages: result.messages,
      });
      await saveProgress(progressPath, progress);
      if (result.normalizedStatus !== "accepted") {
        throw new Error(`${document.encf}: ${result.officialStatus ?? "RFCE nao aceito"}`);
      }
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
  const directory = positionalDirectory ? path.resolve(positionalDirectory) : await latestPackageDirectory();
  ensureInsideWorkspace(directory);
  await access(path.join(directory, "manifest.json"));
  const manifestText = await readFile(path.join(directory, "manifest.json"), "utf8");
  const manifest = parseManifest(manifestText);
  await auditPackage(directory, manifest);
  const direct = manifest.documents.filter((document) => document.phase === "direct_submission")
    .sort((left, right) => left.order - right.order);
  const summaries = manifest.documents.filter((document) => document.phase === "summary_submission")
    .sort((left, right) => left.order - right.order);
  const manual = manifest.documents.filter((document) => document.phase === "manual_portal_upload")
    .sort((left, right) => left.order - right.order);
  const rncs = [...new Set(manifest.documents.map(issuerRnc))];
  if (rncs.length !== 1) throw new Error("O pacote possui mais de um RNC emissor");
  const rnc = rncs[0]!;
  if (!submitEnabled) {
    console.log(JSON.stringify({
      success: true,
      mode: "audit_only",
      environment: "certecf",
      packageDirectory: path.relative(workspace, directory).replace(/\\/g, "/"),
      rnc,
      ready: { direct: direct.length, rfce: summaries.length, manual: manual.length },
      nextCommand: `npm run certification:simulation:complete:send -- --submit --confirm-rnc=${rnc}`,
    }, null, 2));
    return;
  }
  if (confirmedRnc !== rnc) throw new Error(`Confirme o RNC com --confirm-rnc=${rnc}`);
  const progressPath = path.join(directory, "submission-progress.json");
  const progress = await readProgress(progressPath, sha256(manifestText));
  const authentication = await authenticateDgii({
    p12Base64: requiredEnvironment("DGII_CERT_P12_BASE64"),
    certificatePassword: process.env.DGII_CERT_PASSWORD ?? "",
    environment: "certecf",
    requestTimeoutMs: 30_000,
  });
  await sendDirect(directory, direct, authentication.token, progress, progressPath);
  await sendSummaries(directory, summaries, authentication.token, progress, progressPath);
  console.log(JSON.stringify({
    success: true,
    environment: "certecf",
    accepted: { direct: direct.length, rfce: summaries.length },
    manualPortalUploads: manual.map((document) =>
      path.join(directory, "03-upload-manual-ecf32", document.fileName)),
  }, null, 2));
}
main().catch((error: unknown) => {
  const gateway = error instanceof DgiiGatewayError ? error : null;
  console.error(JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : "Falha desconhecida",
    stage: gateway?.stage ?? null,
    type: gateway?.type ?? null,
    httpStatus: gateway?.httpStatus ?? null,
    afterPossibleReceipt: gateway?.afterPossibleReceipt ?? null,
    retrySafety: gateway ? !gateway.afterPossibleReceipt : null,
  }, null, 2));
  process.exitCode = 1;
});
