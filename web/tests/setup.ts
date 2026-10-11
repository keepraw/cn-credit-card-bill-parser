import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'

// Keep test output free of statement data.
if (typeof globalThis.crypto === 'undefined') {
  throw new Error('WebCrypto is required for hashing tests')
}