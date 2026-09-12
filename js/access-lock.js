// 入口动态密码软锁 (纯前端, 防君子定位):
//   遮罩层盖住整个应用, 校验通过或本次会话已解锁(sessionStorage)才移除遮罩。
//   查看源码/禁用 JS 可绕过, 非真正保密; 禁用 JS 时遮罩常驻(fail-closed)。
//
// 密码规则: 取访问者设备本地时间(24h 制), 年(后两位)/月/日/时 各 ×2,
//   每段补零(或取末两位)到 2 位, 顺序拼接成 8 位数字。
//   例: 2026 年 9 月 12 日 14 时 -> 52 18 24 28 -> "52182428"
//   最细单位是「时」, 故密码每整点变化一次。
//
// 容差: 命中「当前小时」或「前一小时」任一密码即通过;
//   前一小时用 new Date(now - 3600000) 重新取四要素, 自动处理跨日/跨月/跨年。
(function () {
    'use strict';

    function pad2(n) {
        n = String(n);
        return n.length < 2 ? '0' + n : n;
    }

    // 由某个 Date 生成 8 位密码
    function passwordOf(date) {
        var y = ((date.getFullYear() % 100) * 2) % 100; // 年后两位 ×2, ≥50 年(2050+)时取末两位保证 2 位
        var m = (date.getMonth() + 1) * 2;              // 月 ×2 (最大 24)
        var d = date.getDate() * 2;                     // 日 ×2 (最大 62)
        var h = date.getHours() * 2;                    // 时 ×2 (最大 46)
        return pad2(y) + pad2(m) + pad2(d) + pad2(h);
    }

    // 校验: 命中当前小时或前一小时(容差)即通过
    function isCorrect(value, now) {
        now = now || new Date();
        var prev = new Date(now.getTime() - 3600000);   // 前一小时, 自动处理跨日/跨月/跨年
        return value === passwordOf(now) || value === passwordOf(prev);
    }

    var LOCK_DISABLE_AT = new Date('2026/9/25 00:00:00');
    function isLockDisabled(now) {
        now = now || new Date();
        return now.getTime() >= LOCK_DISABLE_AT.getTime();
    }

    // Node 环境(单元测试): 仅导出纯函数, 不触碰 DOM
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { pad2: pad2, passwordOf: passwordOf, isCorrect: isCorrect, isLockDisabled: isLockDisabled };
    }
    if (typeof document === 'undefined') return;

    var STORAGE_KEY = 'nr_access_unlocked';
    var overlay = document.getElementById('access-lock-overlay');
    if (!overlay) return;
    if (isLockDisabled()) { overlay.parentNode.removeChild(overlay); return; }
    var card = document.getElementById('access-lock-card');
    var input = document.getElementById('access-lock-input');
    var errorEl = document.getElementById('access-lock-error');
    var btn = document.getElementById('access-lock-btn');

    // 本次会话已解锁: 立即移除遮罩(无闪现)
    try {
        if (sessionStorage.getItem(STORAGE_KEY) === '1') {
            overlay.parentNode.removeChild(overlay);
            return;
        }
    } catch (e) { /* sessionStorage 不可用时按未解锁处理 */ }

    function unlock() {
        try { sessionStorage.setItem(STORAGE_KEY, '1'); } catch (e) { /* 忽略持久化失败 */ }
        overlay.style.opacity = '0';
        setTimeout(function () {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 400);
    }

    function showError() {
        if (errorEl) errorEl.style.visibility = 'visible';
        if (card && card.animate) {
            card.animate(
                [
                    { transform: 'translateX(0)' },
                    { transform: 'translateX(-10px)' },
                    { transform: 'translateX(10px)' },
                    { transform: 'translateX(-6px)' },
                    { transform: 'translateX(6px)' },
                    { transform: 'translateX(0)' }
                ],
                { duration: 320, easing: 'ease-in-out' }
            );
        }
        if (input) { input.focus(); input.select(); }
    }

    function submit() {
        var v = (input.value || '').replace(/\D/g, '');
        if (v.length === 8 && isCorrect(v)) unlock();
        else showError();
    }

    // 仅允许数字输入; 开始重输即清除错误提示
    input.addEventListener('input', function () {
        var digits = input.value.replace(/\D/g, '');
        if (digits !== input.value) input.value = digits;
        if (errorEl) errorEl.style.visibility = 'hidden';
    });
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    btn.addEventListener('click', submit);

    input.focus();
})();
