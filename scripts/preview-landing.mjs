import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../previews/evn-landing/', import.meta.url))
const port = Number(process.env.LANDING_PORT || 3022)
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8' }
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return }
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/') { res.writeHead(302, { Location: '/landing/' }); res.end(); return }
    if (!url.pathname.startsWith('/landing/')) { res.writeHead(404); res.end(); return }
    const relative = decodeURIComponent(url.pathname.slice('/landing/'.length)) || 'index.html'
    const file = path.resolve(root, relative)
    if (!file.startsWith(root) || relative.includes('\\')) { res.writeHead(404); res.end(); return }
    const data = await fs.readFile(file)
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' })
    res.end(req.method === 'HEAD' ? undefined : data)
  } catch { res.writeHead(404); res.end() }
})
server.on('error', error => { console.error(`Landing preview could not start: ${error.code}`); process.exitCode = 1 })
server.listen(port, '127.0.0.1', () => console.log(`EV&Solution local preview: http://127.0.0.1:${server.address().port}/landing/\nLocal demo only. No inquiry storage, delivery, or tracking. Ctrl+C to stop.`))
