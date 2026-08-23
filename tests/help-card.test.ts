import { describe, expect, it } from 'vitest';
import { helpCard, parseHelpCardAction } from '../src/presentation/help-card.js';

describe('help card', () => {
  it('lists the supported Bridge commands and preserves topic context in safe actions', () => {
    const rendered = JSON.stringify(helpCard('thread-1'));
    expect(rendered).toContain('/help');
    expect(rendered).toContain('/current');
    expect(rendered).toContain('/ws list');
    expect(rendered).toContain('thread-1');
  });

  it('accepts only the fixed help action command allowlist', () => {
    expect(parseHelpCardAction({ action: 'help.command', command: '/current', threadId: 'thread-1' })).toEqual({ command: '/current', threadId: 'thread-1' });
    expect(parseHelpCardAction({ action: 'help.command', command: '/cd /' })).toBeUndefined();
    expect(parseHelpCardAction({ action: 'help.command', command: 'delete everything' })).toBeUndefined();
  });
});
