import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LoadedPrompt {
  /** Logged on every model call, e.g. "interviewer@2". */
  version: string;
  system: string;
}

// packages/core/{src,dist}/prompts -> repo root /prompts
const DEFAULT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../prompts');
const cache = new Map<string, LoadedPrompt>();

/** Loads prompts/<name>.md. The file starts with front matter holding `version: <n>`. */
export function loadPrompt(
  name: string,
  dir = process.env.PROMPTS_DIR ?? DEFAULT_DIR,
): LoadedPrompt {
  const key = `${dir}:${name}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const raw = readFileSync(resolve(dir, `${name}.md`), 'utf8').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  const version = match?.[1] ? /^version:\s*(\S+)\s*$/m.exec(match[1])?.[1] : undefined;
  if (!match || !version) throw new Error(`Prompt ${name}.md needs front matter with a version`);

  const prompt = { version: `${name}@${version}`, system: match[2]!.trim() };
  cache.set(key, prompt);
  return prompt;
}
