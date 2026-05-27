export const IS_COMPILED_BINARY =
  (globalThis as Record<string, unknown>).__IMPRINT_COMPILED__ === true;
