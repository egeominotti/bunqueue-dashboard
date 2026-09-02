export const MAX_JOBS = 10000;
export const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_BULK_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_BULK_INPUT_CHARS = 64 * 1024 * 1024;
export const MAX_BULK_PAYLOAD_BYTES = 64 * 1024 * 1024;

export const BULK_SAMPLE = `[
  { "data": { "to": "a@example.com", "template": "welcome" }, "groupId": "tenant-a", "priority": 1, "groupMaxSize": 100 },
  { "data": { "to": "b@example.com", "template": "welcome" }, "groupId": "tenant-b" }
]`;
