import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  X509Certificate,
} from "node:crypto";

import { parsePkcs12 } from "@f-o-t/crypto";
import { DOMParser, onWarningStopParsing } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";

const MAX_P12_BYTES = 256 * 1024;
const MAX_SEED_XML_BYTES = 64 * 1024;

const C14N_ALGORITHM = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const SIGNATURE_ALGORITHM =
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const DIGEST_ALGORITHM = "http://www.w3.org/2001/04/xmlenc#sha256";
const ENVELOPED_SIGNATURE_TRANSFORM =
  "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

export class CertificateConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CertificateConfigurationError";
  }
}

export type SigningMaterial = {
  privateKey: KeyObject;
  certificatePem: string;
};

function decodeBase64Certificate(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, "");

  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  ) {
    throw new CertificateConfigurationError(
      "DGII_CERT_P12_BASE64 nao contem Base64 valido",
    );
  }

  const decoded = Buffer.from(normalized, "base64");
  const canonicalInput = normalized.replace(/=+$/, "");
  const canonicalDecoded = decoded.toString("base64").replace(/=+$/, "");

  if (decoded.length === 0 || canonicalInput !== canonicalDecoded) {
    throw new CertificateConfigurationError(
      "DGII_CERT_P12_BASE64 nao contem Base64 valido",
    );
  }

  if (decoded.length > MAX_P12_BYTES) {
    throw new CertificateConfigurationError(
      "O certificado PKCS#12 excede o limite permitido",
    );
  }

  return decoded;
}

function publicKeyDer(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: "der", type: "spki" }));
}

function certificateMatchesPrivateKey(
  certificate: X509Certificate,
  privateKey: KeyObject,
): boolean {
  return publicKeyDer(certificate.publicKey).equals(
    publicKeyDer(createPublicKey(privateKey)),
  );
}

export async function loadSigningMaterial(
  p12Base64: string,
  password: string,
): Promise<SigningMaterial> {
  const p12Bytes = decodeBase64Certificate(p12Base64);

  try {
    const parsed = await parsePkcs12(p12Bytes, password);
    const privateKey = createPrivateKey({
      key: Buffer.from(parsed.privateKey),
      format: "der",
      type: "pkcs8",
    });

    if (privateKey.asymmetricKeyType !== "rsa") {
      throw new CertificateConfigurationError(
        "O certificado deve possuir chave privada RSA",
      );
    }

    const certificates = [parsed.certificate, ...parsed.chain].map(
      (certificate) => new X509Certificate(Buffer.from(certificate)),
    );
    const certificate = certificates.find((candidate) =>
      certificateMatchesPrivateKey(candidate, privateKey),
    );

    if (!certificate) {
      throw new CertificateConfigurationError(
        "Nenhum certificado corresponde a chave privada do PKCS#12",
      );
    }

    const now = Date.now();
    if (now < new Date(certificate.validFrom).getTime()) {
      throw new CertificateConfigurationError(
        "O certificado digital ainda nao esta valido",
      );
    }
    if (now > new Date(certificate.validTo).getTime()) {
      throw new CertificateConfigurationError(
        "O certificado digital esta expirado",
      );
    }

    return {
      privateKey,
      certificatePem: certificate.toString(),
    };
  } catch (error: unknown) {
    if (error instanceof CertificateConfigurationError) throw error;

    throw new CertificateConfigurationError(
      "Nao foi possivel abrir o PKCS#12; verifique o arquivo e a senha",
    );
  }
}

function parseXmlStrict(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error("Declaracoes DTD ou ENTITY nao sao permitidas");
  }

  return new DOMParser({ onError: onWarningStopParsing }).parseFromString(
    xml,
    "application/xml",
  );
}

export function validateSeedXml(xml: string): void {
  if (Buffer.byteLength(xml, "utf8") > MAX_SEED_XML_BYTES) {
    throw new Error("A resposta de semilla excede o limite permitido");
  }

  const document = parseXmlStrict(xml);
  if (document.documentElement?.localName !== "SemillaModel") {
    throw new Error("A DGII nao retornou um XML SemillaModel valido");
  }

  const value = document.getElementsByTagName("valor").item(0)?.textContent?.trim();
  const date = document.getElementsByTagName("fecha").item(0)?.textContent?.trim();

  if (!value || !date) {
    throw new Error("O XML de semilla nao contem valor e fecha");
  }
}

export function signSeedXml(xml: string, material: SigningMaterial): string {
  validateSeedXml(xml);

  const signer = new SignedXml({
    privateKey: material.privateKey,
    publicCert: material.certificatePem,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    canonicalizationAlgorithm: C14N_ALGORITHM,
  });

  signer.addReference({
    xpath: "/*",
    transforms: [ENVELOPED_SIGNATURE_TRANSFORM],
    digestAlgorithm: DIGEST_ALGORITHM,
    uri: "",
    isEmptyUri: true,
  });
  signer.computeSignature(xml, {
    location: { reference: "/*", action: "append" },
  });

  const signedXml = signer.getSignedXml();
  const signedDocument = parseXmlStrict(signedXml);
  const signature = signedDocument
    .getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "Signature")
    .item(0);

  if (!signature) {
    throw new Error("A assinatura XML nao foi gerada");
  }

  const verifier = new SignedXml({ publicCert: material.certificatePem });
  verifier.loadSignature(signature.toString());
  if (!verifier.checkSignature(signedXml)) {
    throw new Error("A verificacao local da assinatura XML falhou");
  }

  return signedXml;
}
