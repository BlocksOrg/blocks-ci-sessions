import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const actionYmlPath = fileURLToPath(new URL('../../action.yml', import.meta.url));
const indexPath = fileURLToPath(new URL('../index.ts', import.meta.url));

const action = parse(readFileSync(actionYmlPath, 'utf8')) as {
  description: string;
  inputs: Record<string, { required?: boolean; default?: string; description: string }>;
  outputs: Record<string, { description: string }>;
  runs: { using: string; main: string };
};
const indexSource = readFileSync(indexPath, 'utf8');

/** The `INPUT_NAMES` tuple the entrypoint reads inputs from. */
function declaredInputNames(): string[] {
  const block = indexSource.match(/const INPUT_NAMES = \[([\s\S]*?)\] as const;/);
  if (!block) throw new Error('Could not find INPUT_NAMES in index.ts');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('action.yml', () => {
  it('declares every input the entrypoint reads', () => {
    expect(Object.keys(action.inputs).sort()).toEqual(declaredInputNames().sort());
  });

  it('gives every optional input an explicit default', () => {
    for (const [name, spec] of Object.entries(action.inputs)) {
      if (spec.required) continue;
      expect(spec.default, `input "${name}" is missing a default`).toBeDefined();
    }
  });

  it('documents exactly the outputs the entrypoint sets', () => {
    const set = [...indexSource.matchAll(/core\.setOutput\('([^']+)'/g)].map((m) => m[1]);
    expect(new Set(set)).toEqual(new Set(Object.keys(action.outputs)));
  });

  it('keeps expression syntax out of the metadata', () => {
    // GitHub evaluates `${{ ... }}` inside action.yml itself, against a context
    // that has no `secrets`/`github`. One in a description is enough to make the
    // whole file fail to load with "Unrecognized named-value".
    const descriptions = [
      ...Object.values(action.inputs).map((i) => i.description),
      ...Object.values(action.outputs).map((o) => o.description),
      action.description,
    ];
    for (const description of descriptions) {
      expect(description, `"${description}" contains a GitHub expression`).not.toMatch(/\$\{\{/);
    }
  });

  it('runs the committed ESM bundle on node24', () => {
    // Node 20 was removed from the runners, and the toolkit packages are
    // ESM-only, hence the .mjs bundle.
    expect(action.runs.using).toBe('node24');
    expect(action.runs.main).toBe('dist/index.mjs');
  });
});
