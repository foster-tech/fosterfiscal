import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  X509Certificate,
} from "node:crypto";

import { parsePkcs12 } from "@f-o-t/crypto";
import {
  DOMParser,
  onWarningStopParsing,
  XMLSerializer,
} from "@xmldom/xmldom";
import type { Element as XmlElement, Node as XmlNode } from "@xmldom/xmldom";
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

function removeInsignificantWhitespace(node: XmlNode): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3 && !child.nodeValue?.trim()) {
      node.removeChild(child);
      continue;
    }
    removeInsignificantWhitespace(child);
  }
}

function normalizedCertificate(certificatePem: string): string {
  return certificatePem
    .replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----/g, "")
    .replace(/\s/g, "");
}

function elementsByName(parent: XmlElement, localName: string): XmlElement[] {
  return Array.from(
    parent.getElementsByTagNameNS(
      "http://www.w3.org/2000/09/xmldsig#",
      localName,
    ),
  );
}

export function normalizeXmlDocument(xml: string, expectedRoot: string): string {
  const document = parseXmlStrict(xml);
  if (document.documentElement?.localName !== expectedRoot) {
    throw new Error(`O XML nao possui raiz ${expectedRoot}`);
  }
  removeInsignificantWhitespace(document);
  return new XMLSerializer().serializeToString(document);
}

export function normalizeSeedXml(xml: string): string {
  validateSeedXml(xml);
  return normalizeXmlDocument(xml, "SemillaModel");
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
  const normalizedXml = normalizeSeedXml(xml);

  return signNormalizedXmlDocument(normalizedXml, material, "SemillaModel");
}

export function signXmlDocument(
  xml: string,
  material: SigningMaterial,
  expectedRoot: string,
): string {
  const normalizedXml = normalizeXmlDocument(xml, expectedRoot);
  return signNormalizedXmlDocument(normalizedXml, material, expectedRoot);
}

function signNormalizedXmlDocument(
  normalizedXml: string,
  material: SigningMaterial,
  expectedRoot: string,
): string {

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
  signer.computeSignature(normalizedXml, {
    location: { reference: "/*", action: "append" },
  });

  const signedXml = signer.getSignedXml();
  verifyXmlSignature(signedXml, material, expectedRoot);
  return signedXml;
}

export function verifySignedSeedXml(
  signedXml: string,
  material: SigningMaterial,
): void {
  verifyXmlSignature(signedXml, material, "SemillaModel");
}

export function verifyXmlSignature(
  signedXml: string,
  material: SigningMaterial,
  expectedRoot: string,
): void {
  const signedDocument = parseXmlStrict(signedXml);
  const signatures = Array.from(
    signedDocument
    .getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "Signature")
  );
  const signature = signatures[0];

  if (signatures.length !== 1 || !signature) {
    throw new Error("O XML deve conter exatamente uma assinatura");
  }

  const root = signedDocument.documentElement;
  if (!root) throw new Error("O XML assinado nao possui elemento raiz");
  if (root.localName !== expectedRoot) {
    throw new Error(`O XML assinado nao possui raiz ${expectedRoot}`);
  }
  const elementChildren = Array.from(root.childNodes).filter(
    (node): node is XmlElement => node.nodeType === 1,
  );
  if (signature.parentNode !== root || elementChildren.at(-1) !== signature) {
    throw new Error("A assinatura deve ser o ultimo elemento da raiz");
  }

  const canonicalization = elementsByName(signature, "CanonicalizationMethod");
  const signatureMethods = elementsByName(signature, "SignatureMethod");
  const references = elementsByName(signature, "Reference");
  const transforms = elementsByName(signature, "Transform");
  const digestMethods = elementsByName(signature, "DigestMethod");
  const keyInfos = elementsByName(signature, "KeyInfo");
  const x509Data = elementsByName(signature, "X509Data");
  const x509Certificates = elementsByName(signature, "X509Certificate");

  if (
    canonicalization.length !== 1 ||
    canonicalization[0].getAttribute("Algorithm") !== C14N_ALGORITHM ||
    signatureMethods.length !== 1 ||
    signatureMethods[0].getAttribute("Algorithm") !== SIGNATURE_ALGORITHM ||
    references.length !== 1 ||
    references[0].getAttribute("URI") !== "" ||
    transforms.length !== 1 ||
    transforms[0].getAttribute("Algorithm") !==
      ENVELOPED_SIGNATURE_TRANSFORM ||
    digestMethods.length !== 1 ||
    digestMethods[0].getAttribute("Algorithm") !== DIGEST_ALGORITHM
  ) {
    throw new Error("O perfil da assinatura XML nao corresponde ao da DGII");
  }

  if (
    keyInfos.length !== 1 ||
    x509Data.length !== 1 ||
    x509Certificates.length !== 1 ||
    x509Certificates[0].textContent?.replace(/\s/g, "") !==
      normalizedCertificate(material.certificatePem)
  ) {
    throw new Error("KeyInfo/X509Data nao corresponde ao certificado de assinatura");
  }

  const verifier = new SignedXml({ publicCert: material.certificatePem });
  verifier.loadSignature(signature.toString());
  if (!verifier.checkSignature(signedXml)) {
    throw new Error("A verificacao local da assinatura XML falhou");
  }
}

export async function createVerifiedSeedPayload(
  signedXml: string,
  material: SigningMaterial,
): Promise<Blob> {
  return createVerifiedXmlPayload(signedXml, material, "SemillaModel");
}

export async function createVerifiedXmlPayload(
  signedXml: string,
  material: SigningMaterial,
  expectedRoot: string,
): Promise<Blob> {
  const payload = new Blob([signedXml], { type: "text/xml;charset=utf-8" });
  const transmittedXml = await payload.text();
  if (transmittedXml !== signedXml) {
    throw new Error("O payload UTF-8 foi alterado");
  }
  verifyXmlSignature(transmittedXml, material, expectedRoot);
  return payload;
}
