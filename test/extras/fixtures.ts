import { DEFAULT_BYLAWS, cloneBylaws } from '../../src/bylaws.js';
import type { Bylaws } from '../../src/types.js';

export function sampleBylaws(over: Partial<Bylaws['guards']> = {}, rules: Bylaws['rules'] = []): Bylaws {
  return {
    version: 1,
    guards: {
      destructive: { decision: 'ask', allow_targets: ['dist', 'node_modules'] },
      'online-delete': { decision: 'ask' },
      secrets: { read: 'ask', write: 'ask', send: 'deny', hard: true },
      'self-protect': { decision: 'ask' },
      budget: { tool_calls: { soft: 300, hard: 1000, step: 100 }, tokens: { soft: 0, hard: 0, step: 0 } },
      loop: { decision: 'ask' },
      taint: { decision: 'ask', trusted_hosts: [] },
      ...over,
    },
    rules,
    audit: { enabled: true },
    reviewer: cloneBylaws(DEFAULT_BYLAWS).reviewer,
  };
}
