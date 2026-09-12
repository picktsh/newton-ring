import fs from 'fs';
const L = fs.readFileSync('index.html', 'utf8').split(/\r?\n/);
const pats = [/板块/, /runOverlayCheck/, /runOverlayAutoAlign/, /toggleOverlayLock/, /toggleOverlayBlink/, /resetOverlayShift/, /检查对齐/, /自动全局对齐/, /确定对齐/, /手动对齐/, /overlay-stage/, /闪烁/];
L.forEach((s, i) => {
  if (pats.some(p => p.test(s))) console.log((i + 1) + ': ' + s.trim().slice(0, 120));
});
console.log('total lines:', L.length);
