CREATE TABLE IF NOT EXISTS dgii_inbound_auth_seeds (
  id uuid PRIMARY KEY,
  seed_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dgii_inbound_auth_seeds_expiry_idx
  ON dgii_inbound_auth_seeds (expires_at);

CREATE TABLE IF NOT EXISTS dgii_inbound_documents (
  id uuid PRIMARY KEY,
  document_kind varchar(32) NOT NULL
    CHECK (document_kind IN ('ecf', 'commercial_approval')),
  sender_rnc varchar(64) NOT NULL,
  receiver_rnc varchar(11) NOT NULL,
  encf varchar(13) NOT NULL,
  xml_hash char(64) NOT NULL,
  xml_ciphertext bytea NOT NULL,
  xml_iv bytea NOT NULL,
  xml_auth_tag bytea NOT NULL,
  response_xml_ciphertext bytea,
  response_xml_iv bytea,
  response_xml_auth_tag bytea,
  received_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT dgii_inbound_documents_identity_unique
    UNIQUE (document_kind, sender_rnc, receiver_rnc, encf)
);

CREATE INDEX IF NOT EXISTS dgii_inbound_documents_received_at_idx
  ON dgii_inbound_documents (received_at DESC);

COMMENT ON COLUMN dgii_inbound_documents.xml_ciphertext IS
  'XML fiscal recebido cifrado na aplicacao com AES-256-GCM';

COMMENT ON COLUMN dgii_inbound_documents.response_xml_ciphertext IS
  'ARECF assinado cifrado na aplicacao com AES-256-GCM quando aplicavel';
