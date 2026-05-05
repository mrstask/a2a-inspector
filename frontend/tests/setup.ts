/**
 * Test setup file for Vitest
 * This file runs before all tests to set up the testing environment
 */

import 'fake-indexeddb/auto';
import {beforeEach} from 'vitest';

// Mock btoa (base64 encoding) if not available in jsdom
if (typeof global.btoa === 'undefined') {
  global.btoa = (str: string) => Buffer.from(str, 'binary').toString('base64');
}

// jsdom 27 ships a localStorage that lacks setItem/getItem/clear; install a
// minimal in-memory shim so tests can exercise persistence.
function installLocalStorageShim() {
  const data = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? (data.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: shim,
  });
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: shim,
  });
}

installLocalStorageShim();

beforeEach(() => {
  installLocalStorageShim();
});
