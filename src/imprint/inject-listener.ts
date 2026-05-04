/**
 * Injected per-page (Page.addScriptToEvaluateOnNewDocument). Passive
 * capture-phase listeners emit sentinel-prefixed console.log lines that
 * the recorder picks up via Runtime.consoleAPICalled. Sentinel
 * `[IMPRINT]` is exact-match — keep stable.
 */

export const INJECTED_LISTENER_SOURCE = `
(function imprintInjector() {
  if (window.__imprint_injected__) return;
  window.__imprint_injected__ = true;

  const SENTINEL = '[IMPRINT]';
  const MAX_VAL = 200;

  function safeStr(v) {
    try {
      if (v == null) return null;
      const s = String(v);
      return s.length > MAX_VAL ? s.slice(0, MAX_VAL) + '…' : s;
    } catch (e) { return null; }
  }

  function selectorFor(el) {
    try {
      if (!el || !el.tagName) return null;
      if (el.id) return '#' + el.id;
      const parts = [];
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 5) {
        let part = node.tagName.toLowerCase();
        if (node.className && typeof node.className === 'string') {
          const cls = node.className.trim().split(/\\s+/).slice(0, 2).join('.');
          if (cls) part += '.' + cls;
        }
        parts.unshift(part);
        node = node.parentElement;
        depth++;
      }
      return parts.join(' > ');
    } catch (e) { return null; }
  }

  function describe(el) {
    try {
      if (!el || !el.tagName) return {};
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        name: el.getAttribute && el.getAttribute('name') || null,
        type: el.getAttribute && el.getAttribute('type') || null,
        text: safeStr((el.textContent || '').trim()),
        ariaLabel: el.getAttribute && el.getAttribute('aria-label') || null,
        href: el.tagName === 'A' ? el.getAttribute('href') : null,
        selector: selectorFor(el),
      };
    } catch (e) { return {}; }
  }

  function emit(type, payload) {
    try {
      console.log(SENTINEL, type, JSON.stringify(payload));
    } catch (e) { /* ignore */ }
  }

  function onClick(ev) {
    try {
      const tgt = ev.target;
      emit('click', describe(tgt));
    } catch (e) { /* ignore */ }
  }

  function onInput(ev) {
    try {
      const tgt = ev.target;
      // For inputs we capture the field name + a TRUNCATED value preview.
      // Sensitive fields (type=password) get value redacted.
      const desc = describe(tgt);
      if (desc.type === 'password') {
        desc.value = '[redacted password]';
      } else if (tgt && 'value' in tgt) {
        desc.value = safeStr(tgt.value);
      }
      emit('input', desc);
    } catch (e) { /* ignore */ }
  }

  function onChange(ev) {
    try {
      const tgt = ev.target;
      const desc = describe(tgt);
      if (desc.type === 'password') {
        desc.value = '[redacted password]';
      } else if (tgt && 'value' in tgt) {
        desc.value = safeStr(tgt.value);
      }
      emit('change', desc);
    } catch (e) { /* ignore */ }
  }

  function onSubmit(ev) {
    try {
      const form = ev.target;
      const fields = [];
      if (form && form.elements) {
        for (let i = 0; i < form.elements.length; i++) {
          const el = form.elements[i];
          if (!el || !el.name) continue;
          let value = null;
          if (el.type === 'password') {
            value = '[redacted]';
          } else if ('value' in el) {
            value = safeStr(el.value);
          }
          fields.push({ name: el.name, type: el.type || null, value: value });
        }
      }
      emit('submit', {
        selector: selectorFor(form),
        action: form && form.getAttribute && form.getAttribute('action') || null,
        method: form && form.getAttribute && form.getAttribute('method') || 'get',
        fields: fields,
      });
    } catch (e) { /* ignore */ }
  }

  // Capture phase = true so we see the event before the site has a chance to
  // stopPropagation it.
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('submit', onSubmit, true);
})();
`;

export const IMPRINT_SENTINEL = '[IMPRINT]';
