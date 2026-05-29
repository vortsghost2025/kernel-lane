/**
 * stableStringify.js - Deterministic JSON serialization
 *
 * Ensures consistent property ordering for signature verification.
 * Prevents false negatives from JSON.stringify() non-determinism.
 */

function stableStringify(value) {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}

	const keys = Object.keys(value).sort();
	const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
	return `{${entries.join(',')}}`;
}

module.exports = { stableStringify };
