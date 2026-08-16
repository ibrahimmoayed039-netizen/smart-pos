/*
  خادم محلي لنظام نقاط البيع (POS)
  يشغّله "جهاز المدير" (كخادم مدمج داخل تطبيق سطح المكتب، أو يدوياً عبر node)،
  وبقية الأجهزة (الفروع) تتصل به عبر الشبكة المحلية أو عبر VPN (Radmin VPN / Tailscale).
  - يقدّم صفحة البرنامج (POS_System.html) ويحقن طبقة المزامنة تلقائياً.
  - طبقة المزامنة صامدة: لو انقطع الاتصال بالخادم، تستمر الأجهزة بالعمل محلياً
    وتُراكم التغييرات في قائمة انتظار محفوظة، وتُرسلها تلقائياً فور عودة الاتصال.
  - يخزّن البيانات في ملف pos-data.json، ويأخذ نسخاً احتياطية دورية تلقائية
    (مجلد backups) يمكن استخدامها لاستعادة البيانات أو لترقية جهاز آخر ليصبح خادماً.
  - لا يحتاج إنترنت ولا أي مكتبات خارجية (Node.js فقط).

  يمكن استخدامه بطريقتين:
  1) مُدمج داخل Electron:  const { startServer } = require('./server');
                             startServer({ dir, dbFile, port });
  2) مستقل عبر الطرفية:     node server.js
*/
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEFAULT_PORT = 5000;
const BACKUP_INTERVAL_MS = 10 * 60 * 1000; // نسخة احتياطية جديدة كل 10 دقائق كحد أقصى
const BACKUP_KEEP = 30;                    // احتفظ بآخر 30 نسخة فقط

// ── طبقة المزامنة التي تُحقن داخل الصفحة ──
// صامدة لانقطاع الاتصال: التغييرات تُحفظ في localStorage نفسه قبل إرسالها،
// فلا تُفقد حتى لو أُغلق البرنامج أو انقطعت الشبكة، وتُعاد المحاولة تلقائياً.
const SYNC_SCRIPT = `
<script>
(function(){
  if (location.protocol === 'file:') return; // وضع الجهاز المنفرد: بلا مزامنة
  var QUEUE_KEY = '__pos_sync_queue__';
  var BADGE_ID  = '__pos_sync_badge__';

  function loadQueue(){ try{ return JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}'); }catch(e){ return {}; } }
  function saveQueue(q){ try{ localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }catch(e){} }

  var pending = loadQueue(); // تغييرات لم تصل للخادم بعد — تبقى حتى بعد إعادة تشغيل الجهاز
  var isOnline = null;

  function setBadge(text, color){
    var b = document.getElementById(BADGE_ID);
    if(!b){
      if(!document.body) return;
      b = document.createElement('div');
      b.id = BADGE_ID;
      b.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;'+
        'font:12px/1.6 Tajawal,Arial,sans-serif;padding:5px 12px;border-radius:20px;color:#fff;'+
        'box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none;direction:rtl;white-space:nowrap';
      document.body.appendChild(b);
    }
    b.style.background = color;
    b.textContent = text;
  }
  function setOnline(v){
    if (v === isOnline) return;
    isOnline = v;
    if (v) setBadge('🟢 متصل بالخادم', '#0d9e52');
    else setBadge('🔴 غير متصل — يعمل محلياً ويُزامن تلقائياً عند العودة', '#c0392b');
  }

  // تحميل أولي متزامن قبل تشغيل البرنامج
  try {
    var x0 = new XMLHttpRequest();
    x0.open('GET', '/api/db', false);
    x0.send();
    if (x0.status === 200) {
      var res = JSON.parse(x0.responseText);
      var db = res.data || {};
      for (var k in db) { if (db[k] != null) localStorage.setItem(k, db[k]); }
      window.__SYNC_VER = res.version || 0;
      setOnline(true);
    } else { setOnline(false); }
  } catch (e) { setOnline(false); }

  // اعتراض الكتابة: تُحفظ فوراً في localStorage + قائمة الانتظار المحفوظة
  var _set = localStorage.setItem.bind(localStorage);
  var _rem = localStorage.removeItem.bind(localStorage);
  var flushTimer = null, retryTimer = null;
  function schedule(){ if (flushTimer) return; flushTimer = setTimeout(flush, 400); }
  function scheduleRetry(){ if (retryTimer) return; retryTimer = setTimeout(function(){ retryTimer = null; flush(); }, 5000); }
  function flush(){
    flushTimer = null;
    var keys = Object.keys(pending);
    if (!keys.length) return;
    var data = pending;
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/db', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.onload = function(){
        if (x.status === 200) {
          try { window.__SYNC_VER = JSON.parse(x.responseText).version; } catch(e){}
          // احذف من قائمة الانتظار فقط ما لم يُعدَّل مجدداً أثناء الإرسال
          keys.forEach(function(k){ if (pending[k] === data[k]) delete pending[k]; });
          saveQueue(pending);
          setOnline(true);
          if (Object.keys(pending).length) schedule();
        } else { setOnline(false); scheduleRetry(); }
      };
      x.onerror = function(){ setOnline(false); scheduleRetry(); };
      x.send(JSON.stringify(data));
    } catch (e) { setOnline(false); scheduleRetry(); }
  }
  localStorage.setItem = function(k, v){
    _set(k, v);
    if (k.indexOf('pos_') === 0){ pending[k] = v; saveQueue(pending); schedule(); }
  };
  localStorage.removeItem = function(k){
    _rem(k);
    if (k.indexOf('pos_') === 0){ pending[k] = null; saveQueue(pending); schedule(); }
  };

  // إن كان هناك تغييرات معلّقة من جلسة سابقة تعذّر إرسالها، حاول الآن
  if (Object.keys(pending).length) schedule();

  // متابعة تغييرات الأجهزة الأخرى + إعادة محاولة إرسال المتراكم دورياً
  setInterval(function(){
    if (Object.keys(pending).length) { flush(); return; }
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/api/version', true);
      x.onload = function(){
        setOnline(true);
        var v = parseInt(x.responseText) || 0;
        if (!window.__SYNC_VER) { window.__SYNC_VER = v; return; }
        if (v > window.__SYNC_VER) { location.reload(); }   // جهاز آخر عدّل البيانات
      };
      x.onerror = function(){ setOnline(false); };
      x.send();
    } catch (e) { setOnline(false); }
  }, 3000);

  if (document.readyState !== 'loading') setOnline(isOnline);
  else document.addEventListener('DOMContentLoaded', function(){ setOnline(isOnline); });
})();
</script>
`;

// ── تصنيف عناوين IP: شبكة محلية / Radmin VPN / Tailscale ──
function classifyIp(ifaceName, ip) {
  var name = (ifaceName || '').toLowerCase();
  if (name.indexOf('radmin') !== -1) return 'Radmin VPN';
  if (name.indexOf('tailscale') !== -1) return 'Tailscale';
  var parts = ip.split('.').map(Number);
  if (parts[0] === 26) return 'Radmin VPN'; // مدى Radmin VPN الافتراضي
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return 'Tailscale'; // مدى CGNAT الخاص بـ Tailscale
  return 'شبكة محلية (LAN)';
}

// إرجاع كل عناوين IPv4 الخارجية المتاحة على الجهاز مصنّفة حسب النوع
function getLocalIps() {
  var ifaces = os.networkInterfaces();
  var out = [];
  for (var name in ifaces) {
    for (var i = 0; i < ifaces[name].length; i++) {
      var it = ifaces[name][i];
      if (it.family === 'IPv4' && !it.internal) {
        out.push({ iface: name, ip: it.address, label: classifyIp(name, it.address) });
      }
    }
  }
  var order = { 'شبكة محلية (LAN)': 0, 'Radmin VPN': 1, 'Tailscale': 2 };
  out.sort(function(a, b){ return (order[a.label] || 9) - (order[b.label] || 9); });
  return out;
}

// ── نظام النسخ الاحتياطي الدوري ──
// كل ملف بيانات (dbFile) له مجلد "backups" بجواره فيه لقطات مرقّمة بالتاريخ/الوقت.
function backupsDir(dbFile) { return path.join(path.dirname(dbFile), 'backups'); }

function pruneOldBackups(dir) {
  try {
    var files = fs.readdirSync(dir).filter(function (f) { return /^pos-backup-.*\.json$/.test(f); }).sort();
    while (files.length > BACKUP_KEEP) {
      var old = files.shift();
      try { fs.unlinkSync(path.join(dir, old)); } catch (e) {}
    }
  } catch (e) {}
}

function stamp(d) {
  function p2(n) { return String(n).padStart(2, '0'); }
  return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}

// يكتب لقطة احتياطية فورية من الكائن dbObj إلى مجلد backups بجانب dbFile
function writeBackupNow(dbFile, dbObj) {
  try {
    var dir = backupsDir(dbFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var file = path.join(dir, 'pos-backup-' + stamp(new Date()) + '.json');
    fs.writeFileSync(file, JSON.stringify(dbObj));
    pruneOldBackups(dir);
    return { ok: true, file: file };
  } catch (e) { return { ok: false, error: e.message }; }
}

// يرجع قائمة النسخ الاحتياطية المتاحة لملف بيانات معيّن (الأحدث أولاً)
function listBackups(dbFile) {
  var dir = backupsDir(dbFile);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(function (f) { return /^pos-backup-.*\.json$/.test(f); })
      .map(function (f) {
        var full = path.join(dir, f);
        var st = fs.statSync(full);
        return { file: f, path: full, size: st.size, mtime: st.mtimeMs };
      })
      .sort(function (a, b) { return b.mtime - a.mtime; });
  } catch (e) { return []; }
}

// يستعيد محتوى نسخة احتياطية معيّنة داخل dbFile (يستبدل المحتوى الحالي بالكامل)
function restoreBackupInto(dbFile, backupPath) {
  try {
    var content = fs.readFileSync(backupPath, 'utf8');
    JSON.parse(content); // تحقق من سلامة الملف قبل الاستبدال
    // احتفظ بنسخة من الحالة الحالية قبل الاستبدال تحسباً للخطأ
    if (fs.existsSync(dbFile)) writeBackupNow(dbFile, JSON.parse(fs.readFileSync(dbFile, 'utf8')));
    fs.writeFileSync(dbFile, content);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

/*
  startServer(opts)
  opts.dir     مجلّد يحوي POS_System.html (مطلوب)
  opts.dbFile  مسار كامل لملف قاعدة البيانات pos-data.json (مطلوب - يُفضّل مجلد بيانات قابل للكتابة)
  opts.port    المنفذ (اختياري - افتراضي 5000)
  ترجع: { server, port, dbFile, getLocalIps, listBackups, backupNow, stop }
*/
function startServer(opts) {
  opts = opts || {};
  var DIR = opts.dir;
  var DB_FILE = opts.dbFile;
  var PORT = opts.port || DEFAULT_PORT;
  var HTML_FILE = path.join(DIR, 'POS_System.html');

  var DB = {};
  var VERSION = Date.now();
  try { if (fs.existsSync(DB_FILE)) { DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } } catch (e) { DB = {}; }

  var saveTimer = null;
  var lastBackupAt = 0;
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try {
        fs.writeFileSync(DB_FILE, JSON.stringify(DB));
        var now = Date.now();
        if (now - lastBackupAt >= BACKUP_INTERVAL_MS) {
          lastBackupAt = now;
          writeBackupNow(DB_FILE, DB);
        }
      } catch (e) { console.error('فشل الحفظ:', e.message); }
    }, 300);
  }

  function send(res, code, type, body, extra) {
    var h = Object.assign({ 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }, extra || {});
    res.writeHead(code, h);
    res.end(body);
  }

  var server = http.createServer(function (req, res) {
    var url = req.url.split('?')[0];

    if (url === '/api/db' && req.method === 'GET') {
      return send(res, 200, 'application/json', JSON.stringify({ data: DB, version: VERSION }));
    }
    if (url === '/api/db' && req.method === 'POST') {
      var body = '';
      req.on('data', function (c) { body += c; if (body.length > 20e6) req.destroy(); });
      req.on('end', function () {
        try {
          var changes = JSON.parse(body || '{}');
          for (var k in changes) {
            if (changes[k] === null) delete DB[k];
            else DB[k] = changes[k];
          }
          VERSION = Date.now();
          persist();
          send(res, 200, 'application/json', JSON.stringify({ ok: true, version: VERSION }));
        } catch (e) { send(res, 400, 'application/json', JSON.stringify({ error: 'bad json' })); }
      });
      return;
    }
    if (url === '/api/version') {
      return send(res, 200, 'text/plain', String(VERSION));
    }
    // فحص حالة الخادم (يُستخدم من نافذة إعدادات الشبكة لاختبار الاتصال)
    if (url === '/api/ping') {
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, name: 'smart-pos-server' }));
    }

    if (url === '/' || url === '/POS_System.html') {
      fs.readFile(HTML_FILE, 'utf8', function (err, html) {
        if (err) return send(res, 500, 'text/plain', 'POS_System.html غير موجود بجوار الخادم');
        html = html.replace(/<head([^>]*)>/i, '<head$1>\n' + SYNC_SCRIPT);
        send(res, 200, 'text/html; charset=utf-8', html);
      });
      return;
    }

    var safe = path.normalize(path.join(DIR, url)).replace(/^(\.\.[\/\\])+/, '');
    if (safe.indexOf(DIR) === 0 && fs.existsSync(safe) && fs.statSync(safe).isFile()) {
      var ext = path.extname(safe).toLowerCase();
      var types = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
      return send(res, 200, types[ext] || 'application/octet-stream', fs.readFileSync(safe));
    }

    send(res, 404, 'text/plain', 'غير موجود');
  });

  server.listen(PORT, '0.0.0.0');
  // نسخة احتياطية فورية عند بدء تشغيل الخادم لضمان وجود لقطة حديثة دائماً
  lastBackupAt = Date.now();
  writeBackupNow(DB_FILE, DB);

  return {
    server: server,
    port: PORT,
    dbFile: DB_FILE,
    getLocalIps: getLocalIps,
    listBackups: function () { return listBackups(DB_FILE); },
    backupNow: function () { lastBackupAt = Date.now(); return writeBackupNow(DB_FILE, DB); },
    stop: function (cb) { try { server.close(cb); } catch (e) { if (cb) cb(e); } }
  };
}

module.exports = {
  startServer: startServer,
  getLocalIps: getLocalIps,
  listBackups: listBackups,
  writeBackupNow: writeBackupNow,
  restoreBackupInto: restoreBackupInto,
  backupsDir: backupsDir,
  DEFAULT_PORT: DEFAULT_PORT
};

// ── تشغيل مستقل: node server.js (بدون Electron) ──
if (require.main === module) {
  var DIR = __dirname;
  var handle = startServer({ dir: DIR, dbFile: path.join(DIR, 'pos-data.json'), port: DEFAULT_PORT });
  console.log('\n==============================================');
  console.log('  خادم نقطة البيع يعمل الآن ✔');
  console.log('==============================================');
  console.log('  على هذا الجهاز (الخادم):  http://localhost:' + handle.port);
  handle.getLocalIps().forEach(function (it) {
    console.log('  من الأجهزة الأخرى (' + it.label + '):  http://' + it.ip + ':' + handle.port);
  });
  console.log('==============================================');
  console.log('  اترك هذه النافذة مفتوحة. أغلقها لإيقاف الخادم.');
  console.log('  البيانات تُحفظ في: ' + handle.dbFile);
  console.log('  النسخ الاحتياطية في: ' + backupsDir(handle.dbFile));
  console.log('==============================================\n');
}
