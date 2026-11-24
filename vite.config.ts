import { defineConfig } from 'vite'

const identityProxy = {
  '/api/tenant': { target: process.env.IDENTITY_API_ORIGIN || 'http://127.0.0.1:3000' },
  '/api/identity': { target: process.env.IDENTITY_API_ORIGIN || 'http://127.0.0.1:3000' },
}

export default defineConfig({
  server: { proxy: identityProxy },
  preview: { proxy: identityProxy },
})

