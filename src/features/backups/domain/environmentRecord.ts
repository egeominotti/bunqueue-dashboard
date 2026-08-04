export function parseGeneratedEnvironment(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Generated backup environment is malformed');
    const key = line.slice(0, separator);
    const raw = line.slice(separator + 1);
    if (!/^S3_[A-Z0-9_]+$/.test(key)) throw new Error(`Unexpected backup key: ${key}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (raw === 'true' || raw === 'false' || /^\d+$/.test(raw)) parsed = raw;
      else throw new Error(`Generated backup value for ${key} is malformed`);
    }
    result[key] = String(parsed);
  }
  return result;
}
