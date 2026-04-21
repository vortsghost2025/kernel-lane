# Kernel Lane Outbox

Outgoing broadcasts from Kernel Lane to other lanes.

## Broadcast Types

Kernel Lane emits JSON files here when events occur:

- `kernel_release_v{version}.json` — promotion broadcast (type: kernel_release_broadcast)
- `kernel_rejection_v{version}.json` — rejection broadcast (type: kernel_rejection_broadcast)

## Consumers

- **Archivist**: reads broadcasts for release decisions and metadata
- **Library**: reads broadcasts for verification and attestation
- **SwarmMind**: reads broadcasts for stable artifact consumption
