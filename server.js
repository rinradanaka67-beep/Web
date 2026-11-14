// เว็บฝากไฟล์: แอดมินล็อกอินแล้วอัปโหลดไฟล์ได้ ไฟล์เก็บถาวรบนดิสก์ + จำรายการไฟล์ไว้
// ไม่ต้องติดตั้งแพ็กเกจเพิ่ม (Node 18+)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

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

// ---------- ที่เก็บไฟล์ ----------
// โหมด A (แนะนำ): เก็บที่ Supabase Storage — ตั้ง SUPABASE_URL + SUPABASE_SERVICE_KEY (+ SUPABASE_BUCKET ถ้าไม่ใช้ชื่อ files)
// โหมด B: เก็บบนดิสก์ของเซิร์ฟเวอร์ — ตั้ง DATA_DIR ให้ชี้ไปโฟลเดอร์ที่ "ถาวร" (เช่น Persistent Disk ของ Render = /var/data)
const SB_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const SB_BUCKET = (process.env.SUPABASE_BUCKET || 'files').trim();
const USE_SB = !!(SB_URL && SB_KEY);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const INDEX_FILE = path.join(DATA_DIR, 'files.json');
const MAX_BYTES = (Number(process.env.MAX_UPLOAD_MB) || (USE_SB ? 50 : 200)) * 1024 * 1024; // Supabase แพ็กเกจฟรีรับไฟล์ละไม่เกิน 50 MB
const MAYBE_EPHEMERAL = !USE_SB && !!process.env.RENDER && !process.env.DATA_DIR; // รันบน Render แต่ไม่ได้ตั้งที่เก็บถาวร

let index = [];

// --- Supabase Storage (REST) ---
const sbFetch = (pathname, opts = {}) => fetch(`${SB_URL}/storage/v1${pathname}`, {
  ...opts,
  headers: { apikey: SB_KEY, ...(SB_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SB_KEY}` } : {}), ...(opts.headers || {}) },
  signal: opts.signal || AbortSignal.timeout(120000),
});
const sbObj = (key) => `/object/${encodeURIComponent(SB_BUCKET)}/${key.split('/').map(encodeURIComponent).join('/')}`;
const SB_INDEX_KEY = '_index/files.json';
const sbErr = async (r) => `Supabase ตอบ ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`;

async function sbInit() {
  let r = await sbFetch(`/bucket/${encodeURIComponent(SB_BUCKET)}`);
  if (!r.ok) { // ยังไม่มี bucket -> สร้างให้ (private)
    r = await sbFetch('/bucket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: SB_BUCKET, name: SB_BUCKET, public: false }) });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      if (!/already exists|Duplicate/i.test(t)) throw new Error(`สร้าง/ตรวจ bucket "${SB_BUCKET}" ไม่ได้ — Supabase ตอบ ${r.status}: ${t.slice(0, 300)}`);
    }
  }
  const g = await sbFetch(sbObj(SB_INDEX_KEY));
  if (g.ok) { const parsed = await g.json(); if (Array.isArray(parsed)) index = parsed; }
  else if (g.status !== 400 && g.status !== 404) throw new Error('อ่านรายการไฟล์จาก Supabase ไม่ได้ — ' + await sbErr(g)); // ไม่เดาว่าว่างเปล่า กันเขียนทับรายการเดิม
}
async function sbPutIndex() {
  const r = await sbFetch(sbObj(SB_INDEX_KEY), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-upsert': 'true' }, body: JSON.stringify(index, null, 2) });
  if (!r.ok) throw new Error(await sbErr(r));
}
async function sbExistingNames() { // คืน Set ของไฟล์ที่มีอยู่จริงใน bucket หรือ null ถ้าเช็กไม่ได้
  const names = new Set();
  try {
    for (let offset = 0; ; offset += 1000) {
      const r = await sbFetch(`/object/list/${encodeURIComponent(SB_BUCKET)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '', limit: 1000, offset }) });
      if (!r.ok) return null;
      const arr = await r.json();
      for (const o of arr) names.add(o.name);
      if (arr.length < 1000) break;
    }
  } catch (_) { return null; }
  return names;
}

// --- ดิสก์ในเครื่อง ---
if (!USE_SB) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  for (const f of fs.readdirSync(FILES_DIR)) if (f.endsWith('.part')) fs.unlink(path.join(FILES_DIR, f), () => {}); // เก็บกวาดไฟล์ค้างจากอัปโหลดที่ขาดกลางทาง
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (Array.isArray(parsed)) index = parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      const backup = path.join(DATA_DIR, `files.corrupt-${Date.now()}.json`); // ไฟล์รายการเสีย: เก็บสำรองไว้ ไม่เขียนทับ
      try { fs.renameSync(INDEX_FILE, backup); console.error('files.json เสีย ย้ายไปเก็บที่', backup); } catch (_) {}
    }
  }
}
const saveIndexLocal = () => {
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, INDEX_FILE); // เขียนไฟล์ชั่วคราวก่อนแล้วสลับ กันไฟล์พังตอนไฟดับ
};
let saveQueue = Promise.resolve(); // เรียงคิวการบันทึก ไม่ให้เขียนซ้อนกัน
const saveIndex = () => (saveQueue = saveQueue.catch(() => {}).then(() => (USE_SB ? sbPutIndex() : saveIndexLocal())));
const dropFromIndex = (id) => { index = index.filter(f => f.id !== id); };

// ---------- ล็อกอินแอดมิน ----------
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

const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };
const sendFile = (res, file, type = 'text/html; charset=utf-8') => fs.readFile(file, (e, d) => {
  if (e) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(d);
});
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };

const ID_RE = /^[a-f0-9]{32}$/;
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop().trim().slice(0, 200);

// ---------- อัปโหลด (สตรีมลงดิสก์ ไม่โหลดทั้งไฟล์เข้าหน่วยความจำ) ----------
function handleUpload(req, res) {
  let name = '';
  try { name = cleanName(decodeURIComponent(req.headers['x-filename'] || '')); } catch (_) {}
  if (!name) return json(res, 400, { success: false, error: 'ไม่มีชื่อไฟล์' });
  const declared = Number(req.headers['content-length'] || 0);
  const limitMb = Math.round(MAX_BYTES / 1024 / 1024);
  if (declared > MAX_BYTES) {
    json(res, 413, { success: false, error: `ไฟล์ใหญ่เกิน ${limitMb} MB` }, { Connection: 'close' });
    return res.on('finish', () => req.destroy());
  }
  if (USE_SB) return handleUploadSb(req, res, name, limitMb);

  const id = crypto.randomBytes(16).toString('hex');
  const finalPath = path.join(FILES_DIR, id);
  const tmpPath = finalPath + '.part';
  const out = fs.createWriteStream(tmpPath, { flags: 'wx' });
  const hash = crypto.createHash('sha256');
  let size = 0, done = false;

  const abort = (code, msg) => {
    if (done) return; done = true;
    out.destroy(); fs.unlink(tmpPath, () => {});
    if (res.headersSent) return;
    json(res, code, { success: false, error: msg }, { Connection: 'close' });
    res.on('finish', () => req.destroy());
  };

  req.on('data', (chunk) => {
    if (done) return;
    size += chunk.length;
    if (size > MAX_BYTES) return abort(413, `ไฟล์ใหญ่เกิน ${limitMb} MB`);
    hash.update(chunk);
    if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
  });
  req.on('close', () => { if (!req.complete) abort(499, 'การอัปโหลดถูกยกเลิก'); });
  req.on('error', () => abort(400, 'การอัปโหลดผิดพลาด'));
  out.on('error', (e) => { console.error(e); abort(500, 'เขียนไฟล์ลงดิสก์ไม่สำเร็จ'); });
  req.on('end', () => {
    if (done) return;
    out.end(() => {
      if (done) return;
      if (size === 0) return abort(400, 'ไฟล์ว่างเปล่า');
      done = true;
      fs.rename(tmpPath, finalPath, (err) => {
        if (err) { console.error(err); fs.unlink(tmpPath, () => {}); return json(res, 500, { success: false, error: 'บันทึกไฟล์ไม่สำเร็จ' }); }
        const item = {
          id, name, size,
          type: String(req.headers['x-filetype'] || '').slice(0, 100),
          sha256: hash.digest('hex'),
          uploadedAt: new Date().toISOString(),
        };
        index.push(item);
        saveIndex().then(() => json(res, 201, { success: true, file: item })).catch((e) => {
          console.error(e); dropFromIndex(id); fs.unlink(finalPath, () => {});
          json(res, 500, { success: false, error: 'บันทึกรายการไฟล์ไม่สำเร็จ' });
        });
      });
    });
  });
}

// อัปโหลดไป Supabase: รับไฟล์เข้าหน่วยความจำ (ไม่เกิน MAX_BYTES) แล้วส่งต่อทีเดียว
function handleUploadSb(req, res, name, limitMb) {
  const id = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256');
  const chunks = [];
  let size = 0, done = false;

  const abort = (code, msg) => {
    if (done) return; done = true; chunks.length = 0;
    if (res.headersSent) return;
    json(res, code, { success: false, error: msg }, { Connection: 'close' });
    res.on('finish', () => req.destroy());
  };
  req.on('data', (c) => {
    if (done) return;
    size += c.length;
    if (size > MAX_BYTES) return abort(413, `ไฟล์ใหญ่เกิน ${limitMb} MB`);
    hash.update(c); chunks.push(c);
  });
  req.on('close', () => { if (!req.complete) abort(499, 'การอัปโหลดถูกยกเลิก'); });
  req.on('error', () => abort(400, 'การอัปโหลดผิดพลาด'));
  req.on('end', async () => {
    if (done) return;
    if (size === 0) return abort(400, 'ไฟล์ว่างเปล่า');
    done = true;
    const body = Buffer.concat(chunks); chunks.length = 0;
    try {
      const r = await sbFetch(sbObj(id), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }, body });
      if (!r.ok) throw new Error(await sbErr(r));
    } catch (e) {
      console.error('อัปโหลดไป Supabase ไม่สำเร็จ:', e.message);
      return json(res, 502, { success: false, error: 'ส่งไฟล์ไปเก็บที่ Supabase ไม่สำเร็จ' });
    }
    const item = { id, name, size, type: String(req.headers['x-filetype'] || '').slice(0, 100), sha256: hash.digest('hex'), uploadedAt: new Date().toISOString() };
    index.push(item);
    try { await saveIndex(); }
    catch (e) {
      console.error('บันทึกรายการไฟล์ไป Supabase ไม่สำเร็จ:', e.message); dropFromIndex(id);
      sbFetch(`/object/${encodeURIComponent(SB_BUCKET)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [id] }) }).catch(() => {});
      return json(res, 500, { success: false, error: 'บันทึกรายการไฟล์ไม่สำเร็จ' });
    }
    json(res, 201, { success: true, file: item });
  });
}

const server = http.createServer((req, res) => {
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

  // ---------- ดาวน์โหลดผ่านลิงก์ (ใครมีลิงก์ก็โหลดได้ รหัสในลิงก์สุ่ม เดาไม่ได้) ----------
  if (req.method === 'GET' && url.startsWith('/f/')) {
    const id = url.slice(3);
    const item = ID_RE.test(id) && index.find(f => f.id === id);
    if (!item) { res.writeHead(404); return res.end('Not found'); }
    if (USE_SB) {
      return sbFetch(sbObj(id)).then((r) => {
        if (!r.ok || !r.body) { res.writeHead(404); return res.end('ไม่พบไฟล์นี้ในที่เก็บ'); }
        const h = {
          'Content-Type': 'application/octet-stream', // บังคับให้เป็นดาวน์โหลด ไม่ให้เบราว์เซอร์รันไฟล์ HTML/JS ที่อัปโหลดมา
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
          'X-Content-Type-Options': 'nosniff',
        };
        const len = r.headers.get('content-length'); if (len) h['Content-Length'] = len;
        res.writeHead(200, h);
        const s = Readable.fromWeb(r.body);
        res.on('close', () => s.destroy());
        s.on('error', () => res.destroy());
        s.pipe(res);
      }).catch((e) => { console.error('ดาวน์โหลดจาก Supabase ไม่สำเร็จ:', e.message); if (!res.headersSent) { res.writeHead(502); res.end('โหลดไฟล์ไม่สำเร็จ'); } else res.destroy(); });
    }
    const file = path.join(FILES_DIR, id);
    return fs.stat(file, (e, st) => {
      if (e) { res.writeHead(404); return res.end('ไม่พบไฟล์นี้บนเซิร์ฟเวอร์'); }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', // บังคับให้เป็นดาวน์โหลด ไม่ให้เบราว์เซอร์รันไฟล์ HTML/JS ที่อัปโหลดมา
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
        'Content-Length': st.size,
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  }

  // ---------- API ไฟล์ (ต้องล็อกอินแอดมิน) ----------
  if (url === '/api/files' || url.startsWith('/api/files/')) {
    if (!isAuthed(req)) return json(res, 401, { success: false, error: 'กรุณาเข้าสู่ระบบ' });
    const id = url.startsWith('/api/files/') ? url.slice('/api/files/'.length) : null;

    if (req.method === 'GET' && !id) {
      return (USE_SB ? sbExistingNames() : Promise.resolve(null)).then((names) => {
        // missing = มีในรายการแต่ไฟล์จริงหาย (ถ้าเช็กกับ Supabase ไม่ได้ จะไม่ติดป้ายหาย)
        const exists = (f) => USE_SB ? (names ? names.has(f.id) : true) : fs.existsSync(path.join(FILES_DIR, f.id));
        const files = index.map(f => ({ ...f, missing: !exists(f) }));
        json(res, 200, { success: true, files, maxMb: Math.round(MAX_BYTES / 1024 / 1024), maybeEphemeral: MAYBE_EPHEMERAL });
      });
    }
    if (req.method === 'POST' && !id) return handleUpload(req, res);

    if (req.method === 'DELETE' && id) {
      const i = ID_RE.test(id) ? index.findIndex(f => f.id === id) : -1;
      if (i < 0) return json(res, 404, { success: false, error: 'ไม่พบไฟล์' });
      const [removed] = index.splice(i, 1);
      return saveIndex().then(() => {
        if (USE_SB) sbFetch(`/object/${encodeURIComponent(SB_BUCKET)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [id] }) }).catch((e) => console.error('ลบไฟล์ที่ Supabase ไม่สำเร็จ:', e.message));
        else fs.unlink(path.join(FILES_DIR, id), () => {});
        json(res, 200, { success: true });
      }).catch((e) => {
        console.error(e); index.splice(Math.min(i, index.length), 0, removed);
        json(res, 500, { success: false, error: 'บันทึกรายการไม่สำเร็จ' });
      });
    }
    return json(res, 405, { success: false, error: 'ไม่รองรับคำสั่งนี้ (ไฟล์ที่ฝากแล้วแก้ไข/เขียนทับไม่ได้)' });
  }

  if (url === '/login' || url === '/login.html') return sendFile(res, path.join(__dirname, 'public', 'login.html'));
  if (url === '/') return isAuthed(req) ? sendFile(res, path.join(__dirname, 'private', 'admin.html')) : redirect(res, '/login');
  res.writeHead(404); res.end('Not found');
});

(async () => {
  if (USE_SB) {
    try { await sbInit(); }
    catch (e) { console.error('เชื่อมต่อ Supabase ไม่สำเร็จ:', e.message, '\nตรวจ SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_BUCKET'); process.exit(1); }
  }
  server.listen(PORT, () => console.log('เปิดที่ http://localhost:' + PORT + ' | เก็บไฟล์ที่ ' + (USE_SB ? `Supabase bucket "${SB_BUCKET}" (${index.length} ไฟล์ในรายการ)` : DATA_DIR)));
})();
