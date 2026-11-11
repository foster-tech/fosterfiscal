import { createHash } from "node:crypto";
import {
  access,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { authenticateDgii } from "../lib/dgii/authentication";
import { submitRfceCertification } from "../lib/dgii/certification/gateway";
import {
  DgiiGatewayError,
  queryEcfResult,
  submitEcf,
} from "../lib/dgii/ecf/gateway";
import { StoredDgiiMessage, SubmissionStatus } from "../lib/dgii/ecf/submission-types";

type ManifestPhase =
  | "direct_submission"
  | "summary_submission"
  | "manual_portal_upload";

type ManifestDocument = {
  order: number;
  phase: ManifestPhase;
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
  counts: {
    directSubmissions: number;
    summarySubmissions: number;
    manualPortalUploads: number;
  };
  documents: ManifestDocument[];
};

type ProgressRecord = {
  phase: "direct_submission" | "summary_submission";
  caseId: string;
  encf: string;
  status: SubmissionStatus;
  trackId: string | null;
  httpStatus: number | null;
  officialStatus: string | null;
  messages: StoredDgiiMessage[];
  updatedAt: string;
};

type Progress = {
  environment: "certecf";
  manifestSha256: string;
  records: Record<string, ProgressRecord>;
  updatedAt: string;
};

const workspace = process.cwd();
const generatedRoot = path.resolve("examples/certificacion/generated");
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

function recordKey(document: ManifestDocument): string {
  return `${document.phase}:${document.caseId}`;
}

function documentDirectory(phase: ManifestPhase): string {
  if (phase === "direct_submission") return "01-envio-direto";
  if (phase === "summary_submission") return "02-resumos-rfce";
  return "03-upload-manual-ecf32";
}

function issuerRnc(document: ManifestDocument): string {
  if (!document.caseId.endsWith(document.encf)) {
    throw new Error(`caseId inconsistente no manifesto: ${document.caseId}`);
  }
  const value = document.caseId.slice(0, -document.encf.length);
  if (!/^\d{9,11}$/.test(value)) {
    throw new Error(`RNC invalido no manifesto: ${document.caseId}`);
  }
  return value;
}

async function latestPackageDirectory(): Promise<string> {
  const entries = await readdir(generatedRoot, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  if (!names[0]) throw new Error("Nenhum pacote de certificacao foi gerado");
  return path.join(generatedRoot, names[0]);
}

function parseManifest(value: string): Manifest {
  const manifest = JSON.parse(value) as Manifest;
  if (!manifest?.counts || !Array.isArray(manifest.documents)) {
    throw new Error("manifest.json invalido");
  }
  if (
    manifest.counts.directSubmissions !== 21 ||
    manifest.counts.summarySubmissions !== 4 ||
    manifest.counts.manualPortalUploads !== 4
  ) {
    throw new Error("O pacote nao contem os 21 e-CF, 4 RFCE e 4 uploads esperados");
  }
  return manifest;
}

async function auditPackage(packageDirectory: string, manifest: Manifest): Promise<void> {
  const orders = new Set<number>();
  for (const document of manifest.documents) {
    if (orders.has(document.order)) throw new Error(`Ordem duplicada: ${document.order}`);
    orders.add(document.order);
    if (path.basename(document.fileName) !== document.fileName) {
      throw new Error(`Nome de arquivo inseguro: ${document.fileName}`);
    }
    if (!document.xsdValidated || !document.signatureVerified) {
      throw new Error(`Documento nao validado: ${document.caseId}`);
    }
    const filePath = path.join(
      packageDirectory,
      documentDirectory(document.phase),
      document.fileName,
    );
    const xml = await readFile(filePath);
    if (sha256(xml) !== document.sha256) {
      throw new Error(`Hash divergente: ${document.caseId}`);
    }
  }
  if (orders.size !== 29) throw new Error("Quantidade de documentos divergente");
}

async function readProgress(
  progressPath: string,
  manifestHash: string,
): Promise<Progress> {
  try {
    const progress = JSON.parse(await readFile(progressPath, "utf8")) as Progress;
    if (progress.environment !== "certecf" || progress.manifestSha256 !== manifestHash) {
      throw new Error("O progresso existente pertence a outro pacote ou ambiente");
    }
    return progress;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      environment: "certecf",
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
  if (document.phase === "manual_portal_upload") {
    throw new Error("Upload manual nao pode integrar o envio automatico");
  }
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
      messages: result.messages,
    });
    await saveProgress(progressPath, progress);
    if (result.normalizedStatus === "accepted") return;
    if (
      result.normalizedStatus === "rejected" ||
      result.normalizedStatus === "accepted_conditional"
    ) {
      throw new Error(
        `${document.encf}: ${result.officialStatus ?? result.normalizedStatus}`,
      );
    }
    if (attempt < 45) await delay(2_000);
  }
  throw new Error(`${document.encf}: a DGII nao concluiu o processamento em 90 segundos`);
}

async function sendDirectDocuments(
  packageDirectory: string,
  documents: ManifestDocument[],
  token: string,
  progress: Progress,
  progressPath: string,
): Promise<void> {
  for (const document of documents) {
    const key = recordKey(document);
    const existing = progress.records[key];
    if (existing?.status === "accepted") continue;
    if (existing?.status === "indeterminate" && !existing.trackId) {
      throw new Error(
        `${document.encf}: envio anterior indeterminado; confira o portal antes de reenviar`,
      );
    }
    if (existing?.trackId) {
      await waitForDirectResult(document, token, existing.trackId, progress, progressPath);
      continue;
    }

    const xml = await readFile(
      path.join(packageDirectory, "01-envio-direto", document.fileName),
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
        messages: reception.error
          ? [{ code: null, value: reception.error }]
          : [],
      });
      await saveProgress(progressPath, progress);
      await waitForDirectResult(
        document,
        token,
        reception.trackId,
        progress,
        progressPath,
      );
    } catch (error: unknown) {
      if (error instanceof DgiiGatewayError && error.afterPossibleReceipt) {
        updateProgress(progress, document, {
          status: "indeterminate",
          trackId: null,
          httpStatus: error.httpStatus,
          officialStatus: error.message,
          messages: [],
        });
        await saveProgress(progressPath, progress);
      }
      throw error;
    }
  }
}

async function sendSummaryDocuments(
  packageDirectory: string,
  documents: ManifestDocument[],
  token: string,
  progress: Progress,
  progressPath: string,
): Promise<void> {
  for (const document of documents) {
    const existing = progress.records[recordKey(document)];
    if (existing?.status === "accepted") continue;
    if (existing) {
      throw new Error(`${document.encf}: RFCE ja possui tentativa registrada; confira o portal`);
    }
    const xml = await readFile(
      path.join(packageDirectory, "02-resumos-rfce", document.fileName),
      "utf8",
    );
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

  const direct = manifest.documents
    .filter((document) => document.phase === "direct_submission")
    .sort((left, right) => left.order - right.order);
  const summaries = manifest.documents
    .filter((document) => document.phase === "summary_submission")
    .sort((left, right) => left.order - right.order);
  const manual = manifest.documents
    .filter((document) => document.phase === "manual_portal_upload")
    .sort((left, right) => left.order - right.order);
  const rncs = [...new Set(manifest.documents.map(issuerRnc))];
  if (rncs.length !== 1) throw new Error("O pacote possui mais de um RNC emissor");
  const rnc = rncs[0]!;

  if (!submitEnabled) {
    console.log(JSON.stringify({
      success: true,
      mode: "audit_only",
      environment: "certecf",
      packageDirectory: path.relative(workspace, packageDirectory).replace(/\\/g, "/"),
      rnc,
      ready: {
        directSubmissions: direct.length,
        summarySubmissions: summaries.length,
        manualPortalUploads: manual.length,
      },
      nextCommand:
        `npm run certification:send -- --submit --confirm-rnc=${rnc}`,
    }, null, 2));
    return;
  }

  if (confirmedRnc !== rnc) {
    throw new Error(`Confirme o RNC com --confirm-rnc=${rnc}`);
  }
  const progressPath = path.join(packageDirectory, "submission-progress.json");
  const progress = await readProgress(progressPath, sha256(manifestText));
  const authentication = await authenticateDgii({
    p12Base64: requiredEnvironment("DGII_CERT_P12_BASE64"),
    certificatePassword: process.env.DGII_CERT_PASSWORD ?? "",
    environment: "certecf",
    requestTimeoutMs: 30_000,
  });

  await sendDirectDocuments(
    packageDirectory,
    direct,
    authentication.token,
    progress,
    progressPath,
  );
  await sendSummaryDocuments(
    packageDirectory,
    summaries,
    authentication.token,
    progress,
    progressPath,
  );

  console.log(JSON.stringify({
    success: true,
    environment: "certecf",
    accepted: {
      directSubmissions: direct.length,
      summarySubmissions: summaries.length,
    },
    manualPortalUploads: manual.map((document) =>
      path.join(packageDirectory, "03-upload-manual-ecf32", document.fileName)),
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
