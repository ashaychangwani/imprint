import { describe, expect, it } from 'bun:test';
import { createInjectedListenerSource } from '../src/imprint/inject-listener.ts';

describe('createInjectedListenerSource', () => {
  it('captures trusted intent kinds from fixed listener closures', () => {
    const source = createInjectedListenerSource('fixture-token');

    expect(source).toContain("onIntent(ev, 'click')");
    expect(source).toContain("(ev) => onIntent(ev, 'pointerover')");
    expect(source).toContain("(ev) => onIntent(ev, 'pointerdown')");
    expect(source).toContain("(ev) => onIntent(ev, 'focusin')");
    expect(source).not.toContain('const intentKind = ev.type');
  });

  it('captures page-mutable logging primitives before site code runs', () => {
    const source = createInjectedListenerSource('fixture-token');

    expect(source).toContain('const emitLog = console.log.bind(console)');
    expect(source).toContain('const stringify = JSON.stringify.bind(JSON)');
  });
});
