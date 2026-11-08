// เซิร์ฟเวอร์เล็ก ๆ ไม่ต้องติดตั้งแพ็กเกจเพิ่ม (Node 18+)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// โหลด .env
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch (_) {}

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;
const SECRET = process.env.SESSION_SECRET;
if (!ADMIN_KEY || !SECRET) { console.error('ต้องตั้ง ADMIN_KEY และ SESSION_SECRET ใน .env'); process.exit(1); }

const SESSION_MS = 12 * 60 * 60 * 1000;
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const makeToken = () => { const exp = String(Date.now() + SESSION_MS); return exp + '.' + sign(exp); };
const validToken = (t) => {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  return !!sig && safeEq(sig, sign(exp)) && Number(exp) > Date.now();
};
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, v.join('=')]));
const isAuthed = (req) => validToken(cookies(req).session);

// จำกัดการเดารหัส: ผิด 5 ครั้งใน 10 นาที ล็อก IP นั้น
const fails = new Map();
const blocked = (ip) => { const f = fails.get(ip); return f && f.n >= 5 && Date.now() - f.t < 600000; };
const addFail = (ip) => { const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 600000 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };

const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const sendFile = (res, file, type = 'text/html; charset=utf-8') => fs.readFile(file, (e, d) => {
  if (e) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(d);
});
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';

  if (req.method === 'POST' && url === '/api/admin/login') {
    if (blocked(ip)) return json(res, 429, { success: false, error: 'ลองผิดหลายครั้งเกินไป กรุณารอ 10 นาที' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      let key = '';
      try { key = JSON.parse(body).key || ''; } catch (_) {}
      if (key && safeEq(key, ADMIN_KEY)) {
        fails.delete(ip);
        return json(res, 200, { success: true }, { 'Set-Cookie': `session=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
      }
      addFail(ip);
      json(res, 401, { success: false, error: 'คีย์ไม่ถูกต้อง' });
    });
    return;
  }
  if (req.method === 'POST' && url === '/api/admin/logout')
    return json(res, 200, { success: true }, { 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0' });

  if (url === '/login' || url === '/login.html') return sendFile(res, path.join(__dirname, 'public', 'login.html'));
  if (url === '/') return isAuthed(req) ? sendFile(res, path.join(__dirname, 'private', 'admin.html')) : redirect(res, '/login');
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('เปิดที่ http://localhost:' + PORT));
