import { describe, expect, it } from 'bun:test';
import { AKAMAI_SENSOR_COOKIE, abckFlag, isAbckValidated } from '../src/imprint/bot-defense.ts';

describe('bot-defense', () => {
  describe('AKAMAI_SENSOR_COOKIE', () => {
    it('is "_abck"', () => {
      expect(AKAMAI_SENSOR_COOKIE).toBe('_abck');
    });
  });

  describe('isAbckValidated', () => {
    it('returns true when status flag is "0"', () => {
      expect(isAbckValidated('tok~0~xyz')).toBe(true);
    });

    it('returns false when status flag is "-1"', () => {
      expect(isAbckValidated('tok~-1~xyz')).toBe(false);
    });

    it('returns false when undefined', () => {
      expect(isAbckValidated(undefined)).toBe(false);
    });

    it('returns false when empty string', () => {
      expect(isAbckValidated('')).toBe(false);
    });

    it('returns false when malformed (no tilde)', () => {
      expect(isAbckValidated('malformed')).toBe(false);
    });

    it('returns false when status flag is something else', () => {
      expect(isAbckValidated('tok~2~xyz')).toBe(false);
    });
  });

  describe('abckFlag', () => {
    it('returns "0" when status flag is "0"', () => {
      expect(abckFlag('tok~0~x')).toBe('0');
    });

    it('returns "-1" when status flag is "-1"', () => {
      expect(abckFlag('tok~-1~x')).toBe('-1');
    });

    it('returns "?" when undefined', () => {
      expect(abckFlag(undefined)).toBe('?');
    });

    it('returns "?" when empty string', () => {
      expect(abckFlag('')).toBe('?');
    });

    it('returns "?" when malformed (no tilde)', () => {
      expect(abckFlag('malformed')).toBe('?');
    });

    it('extracts arbitrary status values', () => {
      expect(abckFlag('abc~123~def')).toBe('123');
    });
  });
});
