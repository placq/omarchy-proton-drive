function safeInteger(environment: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function clampedIntegerSetting(name: string, fallback: number, minimum: number, environment: NodeJS.ProcessEnv = process.env): number {
  const value = safeInteger(environment, name);
  return value === undefined ? fallback : Math.max(minimum, value);
}

export function positiveIntegerSetting(name: string, fallback: number, environment: NodeJS.ProcessEnv = process.env): number {
  const value = safeInteger(environment, name);
  return value !== undefined && value > 0 ? value : fallback;
}
