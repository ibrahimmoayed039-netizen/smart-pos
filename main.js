/*
  العملية الرئيسية لتطبيق Electron — نظام نقطة البيع (جهاز واحد)
  يفتح واجهة POS_System.html داخل نافذة سطح مكتب خاصة.
  البيانات تُحفظ تلقائياً عبر localStorage في مجلّد بيانات التطبيق،
  وتبقى محفوظة بين كل تشغيل وآخر.
*/
const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { startServer, getLocalIps, listBackups, writeBackupNow, restoreBackupInto, backupsDir, DEFAULT_PORT } = require('./server');

/* ─────────────────────────────────────────────────────────
   ربط عدة أجهزة على نفس الشبكة (خادم رئيسي + عملاء)
   دعم الاتصال عبر LAN عادية أو عبر VPN (Radmin VPN / Tailscale)
   ───────────────────────────────────────────────────────── */
const NET_CONFIG_FILE = path.join(app.getPath('userData'), 'pos-network-config.json');
const POS_DATA_FILE   = path.join(app.getPath('userData'), 'pos-data.json');

function loadNetConfig() {
  try {
    if (fs.existsSync(NET_CONFIG_FILE)) return JSON.parse(fs.readFileSync(NET_CONFIG_FILE, 'utf8'));
  } catch (e) {}
  return null;
}
function saveNetConfig(cfg) {
  fs.writeFileSync(NET_CONFIG_FILE, JSON.stringify(cfg));
}

let serverHandle = null; // مقبض الخادم المدمج (عند تشغيل هذا الجهاز كخادم رئيسي)
let setupWindow = null;
let backupsWindow = null;
let mirrorTimer = null; // مؤقت "المرآة التلقائية" لجهاز العميل (نسخ دورية من بيانات الخادم)
const MIRROR_INTERVAL_MS = 2 * 60 * 1000; // كل دقيقتين

function createSetupWindow() {
  if (setupWindow) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 620, height: 720,
    resizable: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

/* ─── نافذة خطأ اتصال بسيطة لوضع العميل عند تعذّر الوصول للخادم ─── */
function showClientConnectError(cfg, detail) {
  const errWin = new BrowserWindow({
    width: 520, height: 360, resizable: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  });
  const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
  <style>body{font-family:'Tajawal',Arial,sans-serif;background:#eef1f6;color:#1c2733;text-align:center;padding:40px 24px}
  h2{color:#c0392b}p{color:#4b5b70;line-height:1.9;font-size:13.5px}code{direction:ltr;display:inline-block;background:#fff;padding:4px 10px;border-radius:6px}
  button{margin-top:18px;padding:10px 20px;border:none;border-radius:8px;background:#1a56a0;color:#fff;font-size:14px;cursor:pointer;font-family:inherit}
  button.secondary{background:#fff;color:#4b5b70;border:1.5px solid #dbe2ec;margin-inline-start:8px}
  </style></head><body>
  <h2>✘ تعذّر الاتصال بالخادم</h2>
  <p>لم يتمكن هذا الجهاز من الوصول إلى<br><code>http://${cfg.ip}:${cfg.port}</code></p>
  <p>تأكد أن جهاز الخادم الرئيسي يعمل، وأن هذا الجهاز على نفس الشبكة المحلية أو نفس شبكة الـ VPN (Radmin VPN / Tailscale).</p>
  <p>إذا كان الخادم الرئيسي معطّلاً لفترة طويلة، يمكنك فتح "النسخ الاحتياطي" وترقية هذا الجهاز ليعمل كخادم مؤقت (إن كانت خاصية المرآة التلقائية مُفعّلة).</p>
  <button onclick="window.posNetwork.openSettings(); window.close();">فتح إعدادات الاتصال</button>
  <button class="secondary" onclick="window.posNetwork.openBackups(); window.close();">فتح النسخ الاحتياطي</button>
  </body></html>`;
  errWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createBackupsWindow() {
  if (backupsWindow) { backupsWindow.focus(); return; }
  backupsWindow = new BrowserWindow({
    width: 640, height: 640,
    resizable: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  });
  backupsWindow.setMenuBarVisibility(false);
  backupsWindow.loadFile(path.join(__dirname, 'backups.html'));
  backupsWindow.on('closed', () => { backupsWindow = null; });
}

/* ─── المرآة التلقائية: لجهاز "عميل" مُفعَّل عليه cfg.mirror، يسحب نسخة من بيانات
     الخادم دورياً ويحفظها محلياً (userData) كي يمكن ترقية هذا الجهاز لاحقاً ─── */
function startMirror(cfg) {
  stopMirror();
  if (!cfg || cfg.mode !== 'client' || !cfg.mirror) return;
  const pull = async () => {
    try {
      const r = await httpFollow('http://' + cfg.ip + ':' + (cfg.port || DEFAULT_PORT) + '/api/db', 'GET', null, 1);
      if (r.status === 200) {
        const parsed = JSON.parse(r.body);
        fs.writeFileSync(POS_DATA_FILE, JSON.stringify(parsed.data || {}));
        writeBackupNow(POS_DATA_FILE, parsed.data || {});
      }
    } catch (e) { /* تجاهل صامت — سيُعاد المحاولة في الدورة التالية */ }
  };
  pull();
  mirrorTimer = setInterval(pull, MIRROR_INTERVAL_MS);
}
function stopMirror() { if (mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = null; } }

/* ─────────────────────────────────────────────────────────
   ESC/POS — تحويل الفاتورة (HTML) إلى صورة نقطية وإرسالها كأوامر
   طباعة خام لطابعات 58مم / 80مم / مقاس مخصّص — عبر الشبكة (IP)
   أو عبر طابعة ويندوز المثبّتة (USB) باستخدام أداة rawprint.exe.
   ───────────────────────────────────────────────────────── */

// عرض الطباعة الفعّال بالنقاط (dots) — القيم القياسية المعتمدة صناعياً للطابعات الحرارية
// 58مم ⇐ 384 نقطة | 80مم ⇐ 576 نقطة (عند دقة 203 نقطة/بوصة). راجع دليل الطابعة لمقاسات أخرى.
function normalizeWidthDots(widthDots){
  var d = parseInt(widthDots,10) || 384;
  return Math.max(64, Math.round(d/8)*8); // يجب أن يكون العرض مضاعفاً لـ 8
}

// عتبة تحويل BGRA إلى أبيض/أسود (1-bit) ثم حزمها بصيغة ESC/POS الخام GS v 0
function bitmapToEscposRaster(bgra, width, height, threshold){
  threshold = threshold==null ? 190 : threshold;
  var bytesPerRow = Math.ceil(width/8);
  var img = Buffer.alloc(bytesPerRow*height, 0);
  for(var y=0;y<height;y++){
    for(var x=0;x<width;x++){
      var idx=(y*width+x)*4;
      var b=bgra[idx], g=bgra[idx+1], r=bgra[idx+2], a=bgra[idx+3];
      // خلفية شفافة تُعامل كأبيض (لا تُطبع)
      var lum = (a<10) ? 255 : (0.299*r+0.587*g+0.114*b);
      if(lum < threshold){
        var byteIndex = y*bytesPerRow + (x>>3);
        img[byteIndex] |= (0x80 >> (x & 7));
      }
    }
  }
  var xL=bytesPerRow&0xFF, xH=(bytesPerRow>>8)&0xFF;
  var yL=height&0xFF, yH=(height>>8)&0xFF;
  var header=Buffer.from([0x1D,0x76,0x30,0x00, xL,xH, yL,yH]);
  return Buffer.concat([header, img]);
}

function escposBuildFull(rasterBuf, opts){
  opts = opts || {};
  var parts=[];
  parts.push(Buffer.from([0x1B,0x40]));                 // ESC @  تهيئة
  if(opts.openDrawerBefore){
    parts.push(Buffer.from([0x1B,0x70,0x00,0x19,0xFA])); // ESC p 0  فتح الدرج
  }
  parts.push(rasterBuf);
  parts.push(Buffer.from([0x0A,0x0A,0x0A]));            // أسطر فراغ قبل القص
  if(opts.cut!==false){
    parts.push(Buffer.from([0x1D,0x56,0x42,0x00]));      // GS V 66 0  قص جزئي
  }
  return Buffer.concat(parts);
}

// إرسال البايتات لطابعة شبكة (IP:Port) — عادة المنفذ 9100
function sendOverNetwork(ip, port, buf){
  return new Promise(function(resolve){
    var sock=new net.Socket();
    var done=false;
    var timer=setTimeout(function(){ if(!done){ done=true; try{sock.destroy();}catch(e){} resolve({ok:false,error:'انتهت المهلة (Timeout) — تأكد من IP والمنفذ'}); } },6000);
    sock.connect(port||9100, ip, function(){
      sock.write(buf, function(){
        setTimeout(function(){ if(!done){ done=true; clearTimeout(timer); sock.end(); resolve({ok:true}); } }, 300);
      });
    });
    sock.on('error', function(e){ if(!done){ done=true; clearTimeout(timer); resolve({ok:false,error:e.message}); } });
  });
}

// إرسال البايتات لطابعة ويندوز مثبّتة (USB) عبر أداة rawprint.exe المرفقة
function sendOverWindowsPrinter(printerName, buf){
  return new Promise(function(resolve){
    var exePath = path.join(process.resourcesPath || __dirname, 'rawprint.exe');
    if(!fs.existsSync(exePath)) exePath = path.join(__dirname, 'rawprint.exe'); // وضع التطوير
    var tmpFile = path.join(os.tmpdir(), 'posraw_'+Date.now()+'.bin');
    try{ fs.writeFileSync(tmpFile, buf); }catch(e){ return resolve({ok:false,error:'تعذّرت كتابة ملف مؤقت: '+e.message}); }
    var child;
    try{ child = spawn(exePath, [printerName, tmpFile]); }
    catch(e){ try{fs.unlinkSync(tmpFile);}catch(_){} return resolve({ok:false,error:'تعذّر تشغيل أداة الطباعة: '+e.message}); }
    var errOut='';
    child.stderr && child.stderr.on('data', function(d){ errOut+=d.toString(); });
    child.on('close', function(code){
      try{fs.unlinkSync(tmpFile);}catch(_){}
      if(code===0) resolve({ok:true});
      else resolve({ok:false, error: errOut.trim() || ('rawprint فشل برمز '+code) });
    });
    child.on('error', function(e){ try{fs.unlinkSync(tmpFile);}catch(_){} resolve({ok:false,error:e.message}); });
  });
}

// يرسم HTML الفاتورة داخل نافذة مخفية بعرض ثابت (بالنقاط) ثم يلتقطها كصورة
function renderHtmlToBitmap(html, widthDots){
  return new Promise(function(resolve,reject){
    var win = new BrowserWindow({ show:false, width: widthDots, height: 100, webPreferences:{ offscreen:false, sandbox:true } });
    var dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(
      '<html><head><meta charset="utf-8"><style>*{margin:0;padding:0;-webkit-font-smoothing:none}body{width:'+widthDots+'px;background:#fff}</style></head><body>'+html+'</body></html>'
    );
    win.loadURL(dataUrl);
    win.webContents.once('did-finish-load', function(){
      setTimeout(function(){
        win.webContents.executeJavaScript('document.body.scrollHeight').then(function(h){
          var height=Math.max(40, Math.ceil(h));
          win.setContentSize(widthDots, height);
          setTimeout(function(){
            win.webContents.capturePage().then(function(img){
              var sz=img.getSize();
              var bmp=img.toBitmap();
              try{ if(!win.isDestroyed()) win.close(); }catch(e){}
              resolve({ buf:bmp, width:sz.width, height:sz.height });
            }).catch(function(e){ try{win.close();}catch(_){} reject(e); });
          }, 120);
        }).catch(function(e){ try{win.close();}catch(_){} reject(e); });
      }, 250);
    });
    setTimeout(function(){ try{ if(!win.isDestroyed()){ win.close(); reject(new Error('انتهت مهلة تحضير الطباعة')); } }catch(e){} }, 15000);
  });
}

async function escposPrintPipeline(args){
  var html=args.html||'';
  var widthDots=normalizeWidthDots(args.widthDots);
  var target=args.target||{};
  var rendered;
  try{ rendered=await renderHtmlToBitmap(html, widthDots); }
  catch(e){ return { ok:false, error:'تعذّر تحضير الفاتورة: '+e.message }; }
  var raster=bitmapToEscposRaster(rendered.buf, rendered.width, rendered.height, args.threshold);
  var full=escposBuildFull(raster, { cut: args.cut!==false, openDrawerBefore: !!args.openDrawer });
  if(target.type==='network'){
    if(!target.ip) return { ok:false, error:'أدخل عنوان IP للطابعة' };
    return await sendOverNetwork(target.ip, target.port||9100, full);
  } else {
    if(!target.printerName) return { ok:false, error:'اختر طابعة' };
    return await sendOverWindowsPrinter(target.printerName, full);
  }
}

/* طلب HTTP يتبع التحويلات (redirects) — يتجاوز قيود CORS تماماً */
function httpFollow(urlStr, method, body, redirects){
  return new Promise(function(resolve, reject){
    if(redirects==null) redirects=6;
    var u;
    try{ u=new URL(urlStr); }catch(e){ return reject(e); }
    var lib = (u.protocol==='http:')?http:https;
    var headers={};
    var payload=body||null;
    if(payload){ headers['Content-Type']='text/plain;charset=utf-8'; headers['Content-Length']=Buffer.byteLength(payload); }
    var reqOpts={ method:method, headers:headers };
    var req=lib.request(u, reqOpts, function(res){
      var sc=res.statusCode;
      if([301,302,303,307,308].indexOf(sc)>=0 && res.headers.location && redirects>0){
        res.resume();
        var next=new URL(res.headers.location, u).toString();
        var m=(sc===307||sc===308)?method:'GET';
        return resolve(httpFollow(next, m, (m==='GET'?null:payload), redirects-1));
      }
      var data=''; res.setEncoding('utf8');
      res.on('data', function(c){ data+=c; });
      res.on('end', function(){ resolve({ status:sc, body:data }); });
    });
    req.on('error', reject);
    if(payload) req.write(payload);
    req.end();
  });
}

let mainWindow = null;

// menuTemplate يوفّر وصولاً خفيفاً لإعدادات الشبكة دون إظهار قوائم مزعجة (autoHideMenuBar)
const menuTemplate = [
  {
    label: 'الشبكة',
    submenu: [
      { label: 'إعدادات الاتصال بين الأجهزة', click: () => createSetupWindow() },
      { label: 'النسخ الاحتياطي', click: () => createBackupsWindow() },
      { type: 'separator' },
      { label: 'إعادة تشغيل البرنامج', click: () => { app.relaunch(); app.exit(0); } }
    ]
  }
];

function createWindow(loadUrlOrFile) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,                                // أقل عرض يحافظ على شكل الواجهة (شريط جانبي + منتجات + سلة)
    minHeight: 650,
    frame: false,                                   // بنشيل إطار النظام الافتراضي ونرسم شريط عنوان خاص بالبرنامج
    show: false,                                   // لا تُظهرها حتى تجهز (يمنع الوميض الأبيض)
    autoHideMenuBar: true,                          // إخفاء شريط القوائم (يظهر بالضغط على Alt)
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')   // جسر الطابعات + إعدادات الشبكة
    }
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  if (loadUrlOrFile && /^https?:\/\//i.test(loadUrlOrFile)) {
    mainWindow.loadURL(loadUrlOrFile);
    mainWindow.webContents.on('did-fail-load', (evt, code, desc, validatedUrl, isMainFrame) => {
      if (code === -3 || isMainFrame === false) return; // تجاهل إلغاء بسيط أو فشل موارد فرعية
      const cfg = loadNetConfig();
      if (cfg && cfg.mode === 'client') { mainWindow && mainWindow.close(); showClientConnectError(cfg, desc); }
    });
  } else {
    mainWindow.loadFile(loadUrlOrFile || path.join(__dirname, 'POS_System.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();                          // فتح بملء الشاشة
    mainWindow.show();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  wireMaximizeEvents(mainWindow);
}

/* ─── يبدأ التطبيق حسب الإعداد المحفوظ: خادم رئيسي / عميل / (بلا إعداد بعد) ─── */
function launchAccordingToConfig() {
  const cfg = loadNetConfig();

  if (!cfg || !cfg.mode) {
    // أول تشغيل: اسأل المستخدم عن دور هذا الجهاز قبل فتح البرنامج
    createSetupWindow();
    return;
  }

  if (cfg.mode === 'server') {
    try {
      serverHandle = startServer({ dir: __dirname, dbFile: POS_DATA_FILE, port: cfg.port || DEFAULT_PORT });
    } catch (e) {
      dialog.showErrorBox('تعذّر تشغيل الخادم', 'المنفذ ' + (cfg.port || DEFAULT_PORT) + ' مستخدم بالفعل أو محجوب. جرّب منفذاً آخر من إعدادات الشبكة.\n' + e.message);
      createSetupWindow();
      return;
    }
    createWindow('http://localhost:' + (cfg.port || DEFAULT_PORT) + '/');
  } else {
    createWindow('http://' + cfg.ip + ':' + (cfg.port || DEFAULT_PORT) + '/');
    startMirror(cfg);
  }
}

/* ─── IPC: أزرار شريط العنوان المخصص (تصغير/تكبير/إغلاق) ─── */
ipcMain.handle('pos-win-minimize', async (evt) => {
  const w = BrowserWindow.fromWebContents(evt.sender);
  if (w) w.minimize();
});
ipcMain.handle('pos-win-toggle-maximize', async (evt) => {
  const w = BrowserWindow.fromWebContents(evt.sender);
  if (!w) return false;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
  return w.isMaximized();
});
ipcMain.handle('pos-win-close', async (evt) => {
  const w = BrowserWindow.fromWebContents(evt.sender);
  if (w) w.close();
});
ipcMain.handle('pos-win-is-maximized', async (evt) => {
  const w = BrowserWindow.fromWebContents(evt.sender);
  return w ? w.isMaximized() : false;
});

/* ـ نبلّغ الواجهة كل ما تتغير حالة التكبير، عشان أيقونة زر التكبير تتحدّث لوحدها ـ */
function wireMaximizeEvents(win) {
  if (!win) return;
  win.on('maximize', () => win.webContents.send('pos-win-maximized-changed', true));
  win.on('unmaximize', () => win.webContents.send('pos-win-maximized-changed', false));
}

/* ─── IPC: إعدادات الشبكة (تُستخدم من setup.html) ─── */
ipcMain.handle('pos-net-get-config', async () => loadNetConfig());

ipcMain.handle('pos-net-save-config', async (evt, cfg) => {
  try {
    if (!cfg || (cfg.mode !== 'server' && cfg.mode !== 'client')) return { ok: false, error: 'إعداد غير صالح' };
    saveNetConfig(cfg);
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('pos-net-get-local-ips', async () => {
  try { return getLocalIps(); } catch (e) { return []; }
});

ipcMain.handle('pos-net-test-connection', async (evt, args) => {
  const ip = args && args.ip, port = (args && args.port) || DEFAULT_PORT;
  if (!ip) return { ok: false, error: 'أدخل عنوان IP' };
  try {
    const r = await httpFollow('http://' + ip + ':' + port + '/api/ping', 'GET', null, 1);
    if (r.status === 200) return { ok: true };
    return { ok: false, error: 'رمز غير متوقع: ' + r.status };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('pos-net-relaunch', async () => {
  // أوقف الخادم المدمج / المرآة التلقائية إن كانت تعمل قبل إعادة التشغيل
  if (serverHandle) { try { serverHandle.stop(); } catch (e) {} serverHandle = null; }
  stopMirror();
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('pos-net-open-settings', async () => { createSetupWindow(); });
ipcMain.handle('pos-net-open-backups', async () => { createBackupsWindow(); });

/* ─── IPC: النسخ الاحتياطي ─── */
ipcMain.handle('pos-backup-list', async () => {
  try { return listBackups(POS_DATA_FILE); } catch (e) { return []; }
});

ipcMain.handle('pos-backup-create-now', async () => {
  try {
    if (serverHandle) return serverHandle.backupNow();
    if (fs.existsSync(POS_DATA_FILE)) {
      return writeBackupNow(POS_DATA_FILE, JSON.parse(fs.readFileSync(POS_DATA_FILE, 'utf8')));
    }
    return { ok: false, error: 'لا توجد بيانات محلية بعد على هذا الجهاز' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('pos-backup-export', async (evt, args) => {
  try {
    const src = args && args.path;
    if (!src || !fs.existsSync(src)) return { ok: false, error: 'الملف غير موجود' };
    const saveRes = await dialog.showSaveDialog({
      title: 'حفظ نسخة احتياطية',
      defaultPath: path.basename(src),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (saveRes.canceled || !saveRes.filePath) return { ok: false, canceled: true };
    fs.copyFileSync(src, saveRes.filePath);
    return { ok: true, path: saveRes.filePath };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('pos-backup-restore', async (evt, args) => {
  // استعادة نسخة احتياطية داخل بيانات هذا الجهاز الحالية (يتطلب أن يكون خادماً)
  try {
    const src = args && args.path;
    if (!src || !fs.existsSync(src)) return { ok: false, error: 'الملف غير موجود' };
    const r = restoreBackupInto(POS_DATA_FILE, src);
    if (r.ok && serverHandle) {
      // أعد تحميل الخادم بالبيانات الجديدة عبر إعادة تشغيل التطبيق (أبسط وأضمن)
      app.relaunch(); app.exit(0);
    }
    return r;
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('pos-backup-promote', async (evt, args) => {
  // ترقية هذا الجهاز (عميل) ليصبح خادماً رئيسياً باستخدام نسخة احتياطية محفوظة لديه
  try {
    const src = args && args.path;
    const cfg = loadNetConfig() || {};
    if (src && fs.existsSync(src)) {
      const r = restoreBackupInto(POS_DATA_FILE, src);
      if (!r.ok) return r;
    }
    const newCfg = { mode: 'server', port: cfg.port || DEFAULT_PORT };
    saveNetConfig(newCfg);
    stopMirror();
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

/* ─── قائمة الطابعات الحقيقية المرتبطة بالحاسوب ─── */
ipcMain.handle('pos-list-printers', async () => {
  try {
    if (!mainWindow) return [];
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map(p => ({
      name: p.name,
      display: p.displayName || p.name,
      default: !!p.isDefault
    }));
  } catch (e) {
    return [];
  }
});

/* ─── طباعة صامتة لطابعة محددة دون نافذة اختيار ─── */
ipcMain.handle('pos-silent-print', async (evt, args) => {
  const printerName = (args && args.printerName) || '';
  const html = (args && args.html) || '';
  return await new Promise((resolve) => {
    let win = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: false, sandbox: true }
    });
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      setTimeout(() => { try { if (win && !win.isDestroyed()) win.close(); } catch (e) {} win = null; }, 1500);
      resolve(!!ok);
    };
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    win.loadURL(dataUrl);
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          win.webContents.print({
            silent: true,
            deviceName: printerName,
            printBackground: true,
            margins: { marginType: 'none' }
          }, (success) => { finish(success); });
        } catch (e) { finish(false); }
      }, 350);
    });
    // أمان: لا تتعلّق للأبد لو فشل التحميل
    setTimeout(() => finish(false), 12000);
  });
});

/* ─── تصدير أي HTML كملف PDF حقيقي (كشوف الحساب وغيرها) ─── */
ipcMain.handle('pos-export-pdf', async (evt, args) => {
  const html = (args && args.html) || '';
  const suggestedName = (args && args.suggestedName) || 'كشف-حساب.pdf';
  let win = new BrowserWindow({ show: false, webPreferences: { offscreen: false, sandbox: true } });
  try {
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    await win.loadURL(dataUrl);
    await new Promise((r) => setTimeout(r, 300)); // انتظار اكتمال الرسم/الخطوط
    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
    });
    const saveRes = await dialog.showSaveDialog({
      title: 'حفظ كشف الحساب PDF',
      defaultPath: suggestedName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (saveRes.canceled || !saveRes.filePath) { return { ok: false, canceled: true }; }
    fs.writeFileSync(saveRes.filePath, pdfBuffer);
    return { ok: true, path: saveRes.filePath };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { if (win && !win.isDestroyed()) win.close(); } catch (e) {}
  }
});

/* ─── طباعة ESC/POS الخام (58/80مم أو مقاس مخصّص، عبر شبكة أو USB) ─── */
ipcMain.handle('pos-escpos-print', async (evt, args) => {
  try { return await escposPrintPipeline(args || {}); }
  catch (e) { return { ok:false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('pos-escpos-drawer', async (evt, args) => {
  try {
    var buf = Buffer.from([0x1B,0x70,0x00,0x19,0xFA]);
    var target = (args && args.target) || {};
    if (target.type === 'network') return await sendOverNetwork(target.ip, target.port||9100, buf);
    return await sendOverWindowsPrinter(target.printerName, buf);
  } catch (e) { return { ok:false, error: String((e && e.message) || e) }; }
});

// منع تشغيل أكثر من نسخة في نفس الوقت
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    launchAccordingToConfig();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) launchAccordingToConfig();
    });
  });
}

app.on('window-all-closed', () => {
  if (serverHandle) { try { serverHandle.stop(); } catch (e) {} serverHandle = null; }
  stopMirror();
  if (process.platform !== 'darwin') app.quit();
});
