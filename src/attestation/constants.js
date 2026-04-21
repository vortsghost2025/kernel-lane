/**
 * Library‑side constants for communicating with the Archivist attestation
 * recovery orchestrator. The orchestrator is owned exclusively by Archivist; the
 * Library only acts as a client hook that forwards verification failures.
 */

// Base URL for the Archivist orchestrator endpoint. In production this should
// point at the Archivist service; during local development it defaults to the
// localhost address used by the test harness.
const ARCHIVIST_ORCHESTRATOR_URL =
  process.env.ARCHIVIST_ORCHESTRATOR_URL ||
  'http://localhost:3000/orchestrate/recovery';

// Optional request timeout (ms). Adjust as needed for your environment.
const ORCHESTRATOR_REQUEST_TIMEOUT_MS = 5000;

/**
 * Path to the Archivist trust store containing public keys for all lanes.
 * Library reads from this location to verify signatures.
 */
const ARCHIVIST_TRUST_STORE_PATH =
  process.env.ARCHIVIST_TRUST_STORE_PATH ||
  'S:/Archivist-Agent/.trust/keys.json';

/**
 * Path to the Library's own key pair (generated on first run).
 */
const LANE_KEY_PATH =
  process.env.LANE_KEY_PATH ||
  'S:/self-organizing-library/.trust/library.json';

/**
 * Trust store version (must match what's in keys.json)
 */
const TRUST_STORE_VERSION = '1.0';

/**
 * Lane identifier for Library
 */
const LANE_ID = process.env.LANE_ID || 'library';

/**
 * Verification reasons
 */
const VERIFY_REASON = {
  MISSING_SIGNATURE: 'MISSING_SIGNATURE',
  MISSING_LANE: 'MISSING_LANE',
  LANE_MISMATCH: 'LANE_MISMATCH',
  KEY_NOT_FOUND: 'KEY_NOT_FOUND',
  SIGNATURE_MISMATCH: 'SIGNATURE_MISMATCH',
  QUARANTINED: 'QUARANTINED',
  QUARANTINE_MAX_RETRIES: 'QUARANTINE_MAX_RETRIES'
};

module.exports = {
  ARCHIVIST_ORCHESTRATOR_URL,
  ORCHESTRATOR_REQUEST_TIMEOUT_MS,
  ARCHIVIST_TRUST_STORE_PATH,
  LANE_KEY_PATH,
  LANE_ID,
  TRUST_STORE_VERSION,
  VERIFY_REASON
};
