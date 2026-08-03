import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useThemeStore } from '../src/components/dashboard/stores/themeStore';
import { ensureDom } from './domSetup';

const STORAGE_KEY = 'bq-dash-theme';

beforeEach(() => {
  ensureDom();
  globalThis.localStorage.removeItem(STORAGE_KEY);
  useThemeStore.setState({ theme: 'dark' });
});

afterEach(() => {
  globalThis.localStorage.removeItem(STORAGE_KEY);
  useThemeStore.setState({ theme: 'dark' });
  document.documentElement.dataset.theme = 'dark';
  document.documentElement.style.colorScheme = 'dark';
});

describe('themeStore resilient persistence', () => {
  test('a quota error cannot break an in-memory theme change', () => {
    const storage = globalThis.localStorage;
    const original = Object.getOwnPropertyDescriptor(storage, 'setItem');
    Object.defineProperty(storage, 'setItem', {
      configurable: true,
      value: () => {
        const error = new Error('theme quota reached');
        error.name = 'QuotaExceededError';
        throw error;
      },
    });
    try {
      expect(() => useThemeStore.getState().setTheme('light')).not.toThrow();
      expect(useThemeStore.getState().theme).toBe('light');
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(document.documentElement.style.colorScheme).toBe('light');
    } finally {
      if (original) Object.defineProperty(storage, 'setItem', original);
      else Reflect.deleteProperty(storage, 'setItem');
    }
  });

  test('rehydration replaces an invalid theme and rewrites the raw blob canonically', async () => {
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { theme: 'javascript:alert(1)', ignored: 'legacy' }, version: 0 })
    );

    await useThemeStore.persist.rehydrate();

    expect(useThemeStore.getState().theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) as string)).toEqual({
      state: { theme: 'dark' },
      version: 1,
    });
  });

  test('a localStorage SecurityError never escapes the theme setter', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        const error = new Error('theme storage denied');
        error.name = 'SecurityError';
        throw error;
      },
    });
    try {
      expect(() => useThemeStore.getState().setTheme('light')).not.toThrow();
      expect(useThemeStore.getState().theme).toBe('light');
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});
