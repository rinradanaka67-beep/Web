// เว็บฝากไฟล์ — ไม่ต้องติดตั้งแพ็กเกจเพิ่ม (Node 18+)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- โหลด .env ----
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
const MAX_BYTES = (Number(process.env.MAX_MB) || 200) * 1024 * 1024;
const MAX_TOTAL = (Number(process.env.MAX_TOTAL_GB) || 5) * 1073741824;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
for (const f of fs.readdirSync(UPLOAD_DIR)) if (f.startsWith('.tmp-')) fs.unlink(path.join(UPLOAD_DIR, f), () => {});

// ---- ฐานข้อมูลไฟล์ (JSON) ----
let db = {};
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) {}
const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
const totalSize = () => Object.values(db).reduce((n, f) => n + f.size, 0);
const bySlug = (slug) => Object.entries(db).find(([, f]) => f.slug === slug);

const cleanName = (n) => (String(n).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 150)) || 'file';
const RESERVED = /^(api\/(admin|files|upload)(\/|$)|login(\/|$)|admin(\/|$)|f(\/|$))/;
const checkSlug = (slug, selfId) => {
  if (!slug) return null;
  if (slug.length > 100 || !/^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(slug)) return 'ชื่อลิงก์ใช้ได้เฉพาะ a-z 0-9 . _ - และ / (ห้ามเว้นวรรค/ภาษาไทย)';
  if (slug.split('/').some((p) => /^\.+$/.test(p))) return 'ชื่อลิงก์ไม่ถูกต้อง';
  if (RESERVED.test(slug)) return 'ชื่อลิงก์นี้ถูกใช้โดยระบบ';
  const o = bySlug(slug);
  if (o && o[0] !== selfId) return 'มีไฟล์ใช้ชื่อลิงก์นี้อยู่แล้ว';
  return null;
};
const INLINE = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8','.json':'application/json; charset=utf-8' };

// ---- เซสชัน ----
const SESSION_MS = 12 * 60 * 60 * 1000;
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const safeEq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const makeToken = () => { const exp = String(Date.now() + SESSION_MS); return exp + '.' + sign(exp); };
const validToken = (t) => { if (!t) return false; const [exp, sig] = t.split('.'); return !!sig && safeEq(sig, sign(exp)) && Number(exp) > Date.now(); };
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, v.join('=')]));
const isAuthed = (req) => validToken(cookies(req).session);

const fails = new Map();
const blocked = (ip) => { const f = fails.get(ip); return f && f.n >= 5 && Date.now() - f.t < 600000; };
const addFail = (ip) => { const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 600000 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };

// ---- ตัวช่วย ----
const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const sendFile = (res, file) => fs.readFile(file, (e, d) => {
  if (e) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(d);
});
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };
const readBody = (req, cb) => { let b = ''; req.on('data', c => { b += c; if (b.length > 5000) req.destroy(); }); req.on('end', () => { try { cb(JSON.parse(b)); } catch (_) { cb({}); } }); };
const baseUrl = (req) => process.env.BASE_URL || ((req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host);
const linkOf = (req, id) => { const f = db[id]; return baseUrl(req) + (f.slug ? '/' + f.slug : '/f/' + id + '/' + encodeURIComponent(f.name)); };

// รับไฟล์จาก body ลงไฟล์ชั่วคราวแบบสตรีม (ไม่กินแรม) แล้วเรียก done(tmpPath, size)
function receive(req, res, replacingSize, done) {
  const len = Number(req.headers['content-length'] || 0);
  const tooBig = () => json(res, 413, { error: 'ไฟล์ใหญ่เกิน ' + MAX_BYTES / 1048576 + ' MB' });
  if (len > MAX_BYTES) return tooBig();
  if (totalSize() - replacingSize + len > MAX_TOTAL) return json(res, 507, { error: 'พื้นที่เซิร์ฟเวอร์เต็ม' });
  const tmp = path.join(UPLOAD_DIR, '.tmp-' + crypto.randomBytes(8).toString('hex'));
  const out = fs.createWriteStream(tmp);
  let got = 0, dead = false;
  const kill = (fn) => { if (dead) return; dead = true; out.destroy(); fs.unlink(tmp, () => {}); fn(); };
  req.on('data', (c) => { got += c.length; if (got > MAX_BYTES) { kill(tooBig); req.destroy(); } });
  req.on('aborted', () => kill(() => {}));
  req.pipe(out);
  out.on('finish', () => { if (!dead) done(tmp, got); });
  out.on('error', () => kill(() => json(res, 500, { error: 'บันทึกไฟล์ไม่สำเร็จ' })));
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const query = new URLSearchParams(req.url.split('?')[1] || '');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  let pathname = url; try { pathname = decodeURIComponent(url); } catch (_) {}

  // ---- ล็อกอิน / ออกจากระบบ ----
  if (req.method === 'POST' && url === '/api/admin/login') {
    if (blocked(ip)) return json(res, 429, { success: false, error: 'ลองผิดหลายครั้งเกินไป กรุณารอ 10 นาที' });
    return readBody(req, (b) => {
      if (b.key && safeEq(b.key, ADMIN_KEY)) {
        fails.delete(ip);
        return json(res, 200, { success: true }, { 'Set-Cookie': `session=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
      }
      addFail(ip);
      json(res, 401, { success: false, error: 'คีย์ไม่ถูกต้อง' });
    });
  }
  if (req.method === 'POST' && url === '/api/admin/logout')
    return json(res, 200, { success: true }, { 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0' });

  // ---- ลิงก์ดาวน์โหลดสาธารณะ: /ชื่อลิงก์ที่ตั้งเอง  หรือ  /f/<id>/<ชื่อไฟล์> ----
  if (req.method === 'GET' || req.method === 'HEAD') {
    let id = null;
    const custom = bySlug(pathname.replace(/^\/+/, ''));
    if (custom) id = custom[0];
    else { const m = url.match(/^\/f\/([\w-]+)(?:\/.*)?$/); if (m && db[m[1]]) id = m[1]; }
    if (id) {
      const f = db[id], inline = INLINE[path.extname(f.name).toLowerCase()];
      res.writeHead(200, {
        'Content-Type': inline || 'application/octet-stream',
        'Content-Length': f.size,
        'Content-Disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(f.name),
        'Last-Modified': new Date(f.time).toUTCString(),
        'Cache-Control': 'no-cache',   // อัปเดตไฟล์แล้วคนโหลดได้ของใหม่ทันที
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(path.join(UPLOAD_DIR, id)).on('error', () => res.end()).pipe(res);
    }
  }

  // ---- API ฝั่งแอดมิน (ต้องล็อกอิน) ----
  if (url.startsWith('/api/') && !isAuthed(req)) return json(res, 401, { error: 'ยังไม่ได้ล็อกอิน' });

  if (req.method === 'GET' && url === '/api/files')
    return json(res, 200, { base: baseUrl(req), files: Object.keys(db).map(id => ({ id, ...db[id], link: linkOf(req, id) })).sort((a, b) => b.time - a.time) });

  // อัปโหลดไฟล์ใหม่ (ตั้งชื่อลิงก์เองได้ด้วย ?slug=)
  if (req.method === 'POST' && url === '/api/upload') {
    const slug = (query.get('slug') || '').trim().replace(/^\/+|\/+$/g, '');
    const err = checkSlug(slug, null);
    if (err) return json(res, 400, { error: err });
    const name = cleanName(query.get('name') || 'file');
    return receive(req, res, 0, (tmp, size) => {
      if (slug && bySlug(slug)) { fs.unlink(tmp, () => {}); return json(res, 400, { error: 'มีไฟล์ใช้ชื่อลิงก์นี้อยู่แล้ว' }); }
      const id = crypto.randomBytes(9).toString('base64url');
      fs.rename(tmp, path.join(UPLOAD_DIR, id), (e) => {
        if (e) return json(res, 500, { error: 'บันทึกไฟล์ไม่สำเร็จ' });
        db[id] = { name, size, time: Date.now(), ip, ...(slug ? { slug } : {}) }; saveDb();
        json(res, 200, { success: true, id, link: linkOf(req, id) });
      });
    });
  }

  // อัปเดตไฟล์ (เปลี่ยนเนื้อหา ลิงก์เดิมยังใช้ได้)
  const rep = url.match(/^\/api\/files\/([\w-]+)\/replace$/);
  if (req.method === 'POST' && rep) {
    const id = rep[1];
    if (!db[id]) return json(res, 404, { error: 'ไม่พบไฟล์' });
    const name = query.get('name') ? cleanName(query.get('name')) : db[id].name;
    return receive(req, res, db[id].size, (tmp, size) => {
      if (!db[id]) { fs.unlink(tmp, () => {}); return json(res, 404, { error: 'ไฟล์ถูกลบไปแล้ว' }); }
      fs.rename(tmp, path.join(UPLOAD_DIR, id), (e) => {
        if (e) return json(res, 500, { error: 'บันทึกไฟล์ไม่สำเร็จ' });
        Object.assign(db[id], { name, size, time: Date.now() }); saveDb();
        json(res, 200, { success: true, id, link: linkOf(req, id) });
      });
    });
  }

  // แก้ชื่อลิงก์ (slug ว่าง = กลับไปใช้ลิงก์อัตโนมัติ)
  const pat = url.match(/^\/api\/files\/([\w-]+)$/);
  if (req.method === 'PATCH' && pat) {
    const id = pat[1];
    if (!db[id]) return json(res, 404, { error: 'ไม่พบไฟล์' });
    return readBody(req, (b) => {
      const slug = String(b.slug || '').trim().replace(/^\/+|\/+$/g, '');
      const err = checkSlug(slug, id);
      if (err) return json(res, 400, { error: err });
      if (slug) db[id].slug = slug; else delete db[id].slug;
      saveDb(); json(res, 200, { success: true, link: linkOf(req, id) });
    });
  }

  if (req.method === 'DELETE' && pat) {
    if (db[pat[1]]) { fs.unlink(path.join(UPLOAD_DIR, pat[1]), () => {}); delete db[pat[1]]; saveDb(); }
    return json(res, 200, { success: true });
  }

  // ---- หน้าเว็บ ----
  if (url === '/login' || url === '/login.html') return sendFile(res, path.join(__dirname, 'public', 'login.html'));
  if (url === '/') return redirect(res, '/admin');
  if (url === '/admin') return isAuthed(req) ? sendFile(res, path.join(__dirname, 'private', 'admin.html')) : redirect(res, '/login');
  res.writeHead(404); res.end('Not found');
}).listen(PORT, function () {
  this.requestTimeout = 0;   // ไม่ตัดอัปโหลดไฟล์ใหญ่
  this.headersTimeout = 60000;
  this.timeout = 0;
  console.log('เปิดที่ http://localhost:' + PORT);
});
