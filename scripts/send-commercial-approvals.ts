import { createHash } from "node:crypto";
import { access, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { authenticateDgii } from "../lib/dgii/authentication";
import { submitCommercialApprovalCertification } from "../lib/dgii/certification/gateway";
import { DgiiGatewayError } from "../lib/dgii/ecf/gateway";

type ManifestDocument = {
  order: number;
  caseId: string;
  issuerRnc: string;
  buyerRnc: string;
  encf: string;
  fileName: string;
  sha256: string;
  schema: string;
  xsdValidated: boolean;
  signatureVerified: boolean;
};

type Manifest = {
  count: number;
  documents: ManifestDocument[];
};

type ProgressRecord = {
  caseId: string;
  encf: string;
  status: "accepted" | "rejected" | "indeterminate";
  httpStatus: number | null;
  code: string | null;
  officialStatus: string | null;
  messages: string[];
  updatedAt: string;
};

type Progress = {
  environment: "certecf";
  manifestSha256: string;
  records: Record<string, ProgressRecord>;
  updatedAt: string;
};

const workspace = process.cwd();
const generatedRoot = path.resolve("examples/certificacion/approvals/generated");
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensureInsideWorkspace(target: string): void {
  const relative = path.relative(workspace, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("O pacote ACECF deve estar dentro do projeto");
  }
}

async function latestPackageDirectory(): Promise<string> {
  const entries = await readdir(generatedRoot, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  if (!names[0]) throw new Error("Nenhum pacote ACECF foi gerado");
  return path.join(generatedRoot, names[0]);
}

function parseManifest(text: string): Manifest {
  const manifest = JSON.parse(text) as Manifest;
  if (manifest?.count !== 11 || !Array.isArray(manifest.documents)) {
    throw new Error("O manifesto ACECF deve conter exatamente 11 documentos");
  }
  if (manifest.documents.length !== 11) {
    throw new Error("A quantidade de documentos ACECF diverge do manifesto");
  }
  return manifest;
}

async function auditPackage(packageDirectory: string, manifest: Manifest): Promise<void> {
  const orders = new Set<number>();
  const cases = new Set<string>();
  for (const document of manifest.documents) {
    if (orders.has(document.order) || cases.has(document.caseId)) {
      throw new Error(`Documento ACECF duplicado: ${document.caseId}`);
    }
    orders.add(document.order);
    cases.add(document.caseId);
    if (path.basename(document.fileName) !== document.fileName) {
      throw new Error(`Nome de arquivo inseguro: ${document.fileName}`);
    }
    if (document.fileName !== `${document.buyerRnc}${document.encf}.xml`) {
      throw new Error(`Nome de arquivo ACECF invalido: ${document.fileName}`);
    }
    if (!document.xsdValidated || !document.signatureVerified) {
      throw new Error(`Documento nao validado: ${document.caseId}`);
    }
    const xml = await readFile(path.join(packageDirectory, document.fileName));
    if (sha256(xml) !== document.sha256) {
      throw new Error(`Hash divergente: ${document.caseId}`);
    }
  }
}

async function readProgress(progressPath: string, manifestHash: string): Promise<Progress> {
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

async function main(): Promise<void> {
  const packageDirectory = positionalDirectory
    ? path.resolve(positionalDirectory)
    : await latestPackageDirectory();
  ensureInsideWorkspace(packageDirectory);
  const manifestPath = path.join(packageDirectory, "manifest.json");
  await access(manifestPath);
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = parseManifest(manifestText);
  await auditPackage(packageDirectory, manifest);
  const documents = [...manifest.documents].sort((left, right) => left.order - right.order);
  const buyerRncs = [...new Set(documents.map((document) => document.buyerRnc))];
  if (buyerRncs.length !== 1) throw new Error("O pacote ACECF possui mais de um RNC comprador");
  const buyerRnc = buyerRncs[0]!;

  if (!submitEnabled) {
    console.log(JSON.stringify({
      success: true,
      mode: "audit_only",
      environment: "certecf",
      packageDirectory: path.relative(workspace, packageDirectory).replace(/\\/g, "/"),
      buyerRnc,
      ready: documents.length,
      nextCommand:
        `npm run certification:approval:send -- --submit --confirm-rnc=${buyerRnc}`,
    }, null, 2));
    return;
  }
  if (confirmedRnc !== buyerRnc) {
    throw new Error(`Confirme o RNC com --confirm-rnc=${buyerRnc}`);
  }

  const progressPath = path.join(packageDirectory, "submission-progress.json");
  const progress = await readProgress(progressPath, sha256(manifestText));
  const authentication = await authenticateDgii({
    p12Base64: requiredEnvironment("DGII_CERT_P12_BASE64"),
    certificatePassword: process.env.DGII_CERT_PASSWORD ?? "",
    environment: "certecf",
    requestTimeoutMs: 30_000,
  });

  for (const document of documents) {
    const existing = progress.records[document.caseId];
    if (existing?.status === "accepted") continue;
    if (existing) {
      throw new Error(
        `${document.encf}: ja possui tentativa ${existing.status}; confira o portal antes de reenviar`,
      );
    }
    const xml = await readFile(path.join(packageDirectory, document.fileName), "utf8");
    try {
      const result = await submitCommercialApprovalCertification({
        xml,
        fileName: document.fileName,
        token: authentication.token,
      });
      progress.records[document.caseId] = {
        caseId: document.caseId,
        encf: document.encf,
        status: result.accepted ? "accepted" : "rejected",
        httpStatus: result.httpStatus,
        code: result.code,
        officialStatus: result.officialStatus,
        messages: result.messages,
        updatedAt: new Date().toISOString(),
      };
      await saveProgress(progressPath, progress);
      if (!result.accepted) {
        throw new Error(
          `${document.encf}: ${result.officialStatus ?? "Aprovacao comercial rejeitada"}` +
            (result.messages.length ? ` (${result.messages.join("; ")})` : ""),
        );
      }
    } catch (error: unknown) {
      if (error instanceof DgiiGatewayError && error.afterPossibleReceipt) {
        progress.records[document.caseId] = {
          caseId: document.caseId,
          encf: document.encf,
          status: "indeterminate",
          httpStatus: error.httpStatus,
          code: null,
          officialStatus: error.message,
          messages: [],
          updatedAt: new Date().toISOString(),
        };
        await saveProgress(progressPath, progress);
      }
      throw error;
    }
  }

  console.log(JSON.stringify({
    success: true,
    environment: "certecf",
    acceptedCommercialApprovals: documents.length,
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
