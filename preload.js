/*
  جسر آمن (contextBridge) يتيح لواجهة POS_System.html:
  - قراءة قائمة الطابعات الحقيقية المرتبطة بالحاسوب.
  - الطباعة الصامتة لطابعة محددة دون إظهار نافذة الطباعة.
*/
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posNative', {
  isElectron: true,
  listPrinters: function () { return ipcRenderer.invoke('pos-list-printers'); },
  silentPrint: function (printerName, html) {
    return ipcRenderer.invoke('pos-silent-print', { printerName: printerName, html: html });
  },
  escposPrint: function (args) { return ipcRenderer.invoke('pos-escpos-print', args); },
  escposDrawer: function (args) { return ipcRenderer.invoke('pos-escpos-drawer', args); },
  exportPDF: function (html, suggestedName) { return ipcRenderer.invoke('pos-export-pdf', { html: html, suggestedName: suggestedName }); }
});

/*
  جسر إعدادات ربط الأجهزة (خادم رئيسي / عميل) — تستخدمه نافذة setup.html،
  ويُستخدم أيضاً من داخل POS_System.html لإظهار زر "إعدادات الشبكة" إن رغبت.
*/
contextBridge.exposeInMainWorld('posNetwork', {
  getConfig: function () { return ipcRenderer.invoke('pos-net-get-config'); },
  saveConfig: function (cfg) { return ipcRenderer.invoke('pos-net-save-config', cfg); },
  getLocalIps: function () { return ipcRenderer.invoke('pos-net-get-local-ips'); },
  testConnection: function (ip, port) { return ipcRenderer.invoke('pos-net-test-connection', { ip: ip, port: port }); },
  relaunch: function () { return ipcRenderer.invoke('pos-net-relaunch'); },
  openSettings: function () { return ipcRenderer.invoke('pos-net-open-settings'); },
  openBackups: function () { return ipcRenderer.invoke('pos-net-open-backups'); }
});

/*
  جسر شريط العنوان المخصص — تصغير/تكبير-استعادة/إغلاق النافذة،
  وإشعار الواجهة عند تغيّر حالة التكبير (مثلاً بالسحب لأعلى الشاشة).
*/
contextBridge.exposeInMainWorld('posWindow', {
  minimize: function () { return ipcRenderer.invoke('pos-win-minimize'); },
  toggleMaximize: function () { return ipcRenderer.invoke('pos-win-toggle-maximize'); },
  close: function () { return ipcRenderer.invoke('pos-win-close'); },
  isMaximized: function () { return ipcRenderer.invoke('pos-win-is-maximized'); },
  onMaximizedChange: function (cb) {
    ipcRenderer.on('pos-win-maximized-changed', function (evt, isMax) { cb(isMax); });
  }
});

/*
  جسر النسخ الاحتياطي — تستخدمه نافذة backups.html لعرض/تصدير/استعادة/ترقية النسخ.
*/
contextBridge.exposeInMainWorld('posBackup', {
  list: function () { return ipcRenderer.invoke('pos-backup-list'); },
  createNow: function () { return ipcRenderer.invoke('pos-backup-create-now'); },
  export: function (path) { return ipcRenderer.invoke('pos-backup-export', { path: path }); },
  restore: function (path) { return ipcRenderer.invoke('pos-backup-restore', { path: path }); },
  promote: function (path) { return ipcRenderer.invoke('pos-backup-promote', { path: path }); }
});
