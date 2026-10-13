/** Execute the existing TypeScript generator with Vite, without a second TS runner dependency. */
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({
  root, configFile: false, logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null }, appType: 'custom',
})
try {
  const { main } = await server.ssrLoadModule('/scripts/generate-golden.ts')
  process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 2
} finally {
  await server.close()
}
