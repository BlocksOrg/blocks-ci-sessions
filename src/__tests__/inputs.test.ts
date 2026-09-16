import { describe, expect, it } from 'vitest';
import { InputError, parseInputs } from '../inputs';

const UUID = '11111111-2222-4333-8444-555555555555';

const base = { blocks_api_key: 'key', prompt: 'do the thing' };

describe('parseInputs', () => {
  it('applies the documented defaults', () => {
    const inputs = parseInputs(base);
    expect(inputs).toMatchObject({
      apiKey: 'key',
      prompt: 'do the thing',
      apiBaseUrl: 'https://api.blocks.team',
      isPrivate: false,
      failOnTimeout: true,
      timeoutMs: 30 * 60_000,
      pollIntervalMs: 5_000,
    });
    expect(inputs.agent).toBeUndefined();
    expect(inputs.agentId).toBeUndefined();
  });

  it('leaves agent unset rather than defaulting it', () => {
    expect(parseInputs({ ...base, agent: '   ' }).agent).toBeUndefined();
  });

  it('normalises agent casing', () => {
    expect(parseInputs({ ...base, agent: 'Claude' }).agent).toBe('claude');
  });

  it('rejects an unknown agent alias', () => {
    expect(() => parseInputs({ ...base, agent: 'gpt' })).toThrow(InputError);
  });

  it('rejects agent and agent_id together', () => {
    expect(() => parseInputs({ ...base, agent: 'claude', agent_id: UUID })).toThrow(
      /mutually exclusive/,
    );
  });

  it('requires a non-blank prompt', () => {
    expect(() => parseInputs({ ...base, prompt: '  \n ' })).toThrow(/prompt/);
  });

  it('requires an api key', () => {
    expect(() => parseInputs({ ...base, blocks_api_key: '' })).toThrow(/blocks_api_key/);
  });

  it('preserves prompt whitespace, which is often meaningful', () => {
    expect(parseInputs({ ...base, prompt: '  line1\n  line2  ' }).prompt).toBe(
      '  line1\n  line2  ',
    );
  });

  it('rejects a non-uuid session_id', () => {
    expect(() => parseInputs({ ...base, session_id: 'nope' })).toThrow(/UUID/);
  });

  it('accepts uuid identifiers', () => {
    const inputs = parseInputs({ ...base, session_id: UUID, session_group_id: UUID });
    expect(inputs.sessionId).toBe(UUID);
    expect(inputs.sessionGroupId).toBe(UUID);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['1', true],
    ['false', false],
    ['off', false],
  ])('parses is_private=%s', (value, expected) => {
    expect(parseInputs({ ...base, is_private: value }).isPrivate).toBe(expected);
  });

  it('rejects a non-boolean is_private', () => {
    expect(() => parseInputs({ ...base, is_private: 'maybe' })).toThrow(/boolean/);
  });

  it('rejects a poll interval below one second', () => {
    expect(() => parseInputs({ ...base, poll_interval_seconds: '0.5' })).toThrow(/at least 1/);
  });

  it('rejects a non-numeric timeout', () => {
    expect(() => parseInputs({ ...base, timeout_minutes: 'soon' })).toThrow(/number/);
  });

  it('strips trailing slashes from api_base_url', () => {
    expect(parseInputs({ ...base, api_base_url: 'http://localhost:9000//' }).apiBaseUrl).toBe(
      'http://localhost:9000',
    );
  });

  it('rejects an over-long title', () => {
    expect(() => parseInputs({ ...base, title: 'x'.repeat(201) })).toThrow(/200 characters/);
  });
});
