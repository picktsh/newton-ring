import { LAMBDA, INSTRUMENT_ERROR } from './constants.js';

// 环半径取值: 优先椭圆拟合的长短半轴均值 (亚像素, 精度高), 椭圆缺失/退化时回退 avgRadius。
// 旧缓存里的 avgRadius 是「4 个整数关键点距离平均」(会出现 .00 假精度), 但 ellipse 对象已随环缓存,
// 故对旧数据也能现算出亚像素半径, 无需重新处理; 新识别的环在源头已把 avgRadius 改为椭圆值。
// 导出供 app.js 表1 模板直接调用 (表1 直径单元格读的是 ring 对象, 不走 diameterData)。
export function ringRadius(ring) {
    const e = ring?.ellipse;
    if (e && e.size && e.size.width > 0 && e.size.height > 0) {
        return (e.size.width + e.size.height) / 4;
    }
    return ring?.avgRadius ?? 0;
}

// 计算各暗环直径数据
export function calculateDiameterData(detectedRings, pixelScale) {
    if (!detectedRings || detectedRings.length === 0) {
        return [];
    }
    return detectedRings.map(ring => ({
        number: ring.number,
        diameterPixel: ringRadius(ring) * 2,
        diameterMM: ringRadius(ring) * 2 * pixelScale
    }));
}

// 逐差法「平方差」列 (Dm²−Dn²) 应保留的小数位: 按误差传播定小数位。
// 直径 D 显示/精确到 0.001mm (末位 1 个单位), 其平方的绝对精度 ≈ 2·D·0.001;
// 减法按小数位数对齐 → 取 Dm²、Dn² 中较少的小数位 (即较大直径对应的位数);
// 将该绝对精度修约到 1 位有效数字后, 其末位所在小数位即为平方差应保留的小数位。
function squareDiffDecimals(Dm, Dn) {
    const maxD = Math.max(Math.abs(Dm), Math.abs(Dn));
    const p = 2 * maxD * 0.001;               // 平方项绝对精度 (直径末位 0.001mm 传播)
    if (!isFinite(p) || p <= 0) return 3;
    let exp = Math.floor(Math.log10(p));      // p = lead × 10^exp
    let lead = Math.round(p / Math.pow(10, exp));
    if (lead >= 10) { lead = 1; exp += 1; }   // 修约到 1 位有效数字 (逢十进位跨数量级)
    return Math.max(0, -exp);                 // 末位所在小数位
}

// 有效数字计数 (与 app.js 同口径): 先按 decimals 位小数修约表示, 去小数点与前导零后数位数 (含末尾零)
function countSigFigs(num, decimals) {
    if (!isFinite(num) || num === 0) return 0;
    const digits = Math.abs(num).toFixed(decimals).replace('.', '').replace(/^0+/, '');
    return digits.length;
}
// 按有效数字修约并用四舍六入五成双格式化为普通小数字符串。
// decimals = sig − 整数位数; 修约后若进位跨数量级 (如 9.9995→10.00) 则按新数量级重算一次, 保证恰好 sig 位有效数字。
function formatSigFigsHalfEven(num, sig) {
    if (!isFinite(num) || num === 0 || sig <= 0) return '0';
    let d = Math.floor(Math.log10(Math.abs(num))) + 1;   // 整数位数
    let decimals = Math.max(0, sig - d);
    let text = roundHalfEven(num, decimals);
    const d2 = Math.floor(Math.log10(Math.abs(Number(text)))) + 1;
    if (d2 !== d) {                                      // 进位跨位: 按新数量级重修约
        decimals = Math.max(0, sig - d2);
        text = roundHalfEven(num, decimals);
    }
    return text;
}

// 计算曲率半径 (使用逐差法，步长 m-n 可人工调节，默认 5)
export function calculateRadiusData(detectedRings, pixelScale, step = 5) {
    if (!detectedRings || detectedRings.length === 0) {
        return [];
    }
    const results = [];
    let totalRadius = 0;
    let validGroups = 0;
    const sortedRings = [...detectedRings].sort((a, b) => b.avgRadius - a.avgRadius);
    // 人工可修改编号且去除环后保持原编号，分组范围以最大编号为准 (而非环数)
    const maxRingNumber = Math.max(...sortedRings.map(r => r.number));
    // 动态生成分组配置 (步长由人工指定)
    const dynamicGroups = generateDynamicGroups(maxRingNumber, step);
    dynamicGroups.forEach(group => {
        const ringM = detectedRings.find(r => r.number === group.m);
        const ringN = detectedRings.find(r => r.number === group.n);

        if (ringM && ringN) {
            const Dm = ringRadius(ringM) * 2 * pixelScale;
            const Dn = ringRadius(ringN) * 2 * pixelScale;
            // R = (Dm² - Dn²) / [4(m-n)λ]
            const diffSquared = Math.pow(Dm, 2) - Math.pow(Dn, 2);
            const R = (diffSquared * 1e-6) / (4 * (group.m - group.n) * LAMBDA);
            // 平方差按误差传播定小数位, 中间量 diffSquared 保留全精度 (多于"多保留 1 位"),
            // 最终显示用四舍六入五成双修约到该小数位 (diffSquaredText)
            const diffSqDecimals = squareDiffDecimals(Dm, Dn);
            // 本组 R 有效数字 = 本组差值 (按显示修约值) 的有效数字; 减法会损失有效数字, 各组位数可不同。
            // R 由全精度 diffSquared 算出 (中间多保留), 每组完成减法后单独修约一次 (四舍六入五成双)。
            const radiusSigFigs = countSigFigs(diffSquared, diffSqDecimals);
            const radiusValid = diffSquared > 0 && isFinite(R) && R > 0 && radiusSigFigs > 0;
            const radiusText = radiusValid ? formatSigFigsHalfEven(R, radiusSigFigs) : '—';
            const radiusRounded = radiusValid ? Number(radiusText) : R;

            results.push({
                group: `D${group.m} 与 D${group.n}`,
                m: group.m,
                n: group.n,
                Dm,
                Dn,
                diffSquared,
                diffSqDecimals,
                diffSquaredText: roundHalfEven(diffSquared, diffSqDecimals),
                radius: R,                 // 全精度 (仅内部参考, 不显示)
                radiusSigFigs,
                radiusRounded,             // 修约后数值: 供 R̄ 与不确定度统计使用
                radiusText                 // 修约后字符串: 表2 与 CSV 显示
            });
            totalRadius += R;
            validGroups++;
        }
    });

    return results;
}

// 动态生成分组配置 (步长可调，默认 5)
function generateDynamicGroups(maxRingNumber, step = 5) {
    if (maxRingNumber < step + 1) {
        return [];
    }
    const groups = [];
    for (let m = maxRingNumber; m >= step + 1; m--) {
        const n = m - step;
        if (n >= 1) {
            groups.push({ m, n });
            // 最多生成5组
            // if (groups.length >= 5) break;
        }
    }
    return groups;
}

// 计算平均曲率半径 (用各组修约后的 R, 与表2 显示值一致: "拿计算器按表里数字求平均"逐位吻合)
export function calculateAverageRadius(radiusData) {
    if (!radiusData || radiusData.length === 0) {
        return 0;
    }
    const total = radiusData.reduce((sum, item) => sum + (item.radiusRounded ?? item.radius), 0);
    return total / radiusData.length;
}

// 生成完整的计算结果对象
export function generateCalculationResults(diameterData, radiusData, averageRadius, pixelScale, uncertainty = null) {
    if (!diameterData || diameterData.length === 0) {
        return null;
    }
    return {
        diameterData,
        radiusData,
        averageR: averageRadius,
        pixelScale,
        uncertainty,
        timestamp: new Date().toLocaleString('zh-CN')
    };
}

// ===== 平均曲率半径的不确定度评定 =====
// 不确定度修约: 一般保留 1 位有效数字, 首位有效数字为 1 或 2 时保留 2 位; 采用"只进不舍"(逢余即入, 宁大勿小)。
// 返回 { text, decimals }: text=修约后字符串; decimals=该结果实际小数位 (供均值 R̄ 四舍六入五成双对齐 U 末位)。
function sigU(x) {
    if (!isFinite(x) || x === 0) return { text: '0', decimals: 0 };
    const ax = Math.abs(x);
    const exp = Math.floor(Math.log10(ax));                  // 数量级: ax = d.ddd × 10^exp
    const lead = Math.floor(ax / Math.pow(10, exp) + 1e-9);  // 首位有效数字 (按原值判定; +1e-9 防浮点噪声如 2.9999999)
    const sig = (lead === 1 || lead === 2) ? 2 : 1;          // 首位 1/2 → 2 位有效, 否则 1 位
    const q = Math.pow(10, exp - (sig - 1));                 // 修约量子: 末位保留数字所在位权
    // 只进不舍: 向上取整到 q 的整数倍 (减 1e-9 噪声容差, 避免 3.0000000004 被误进位)
    const r = Math.ceil(ax / q - 1e-9) * q;                  // 修约结果 (可能进位跨数量级, 如 0.0999 → 0.1)
    const expR = r > 0 ? Math.floor(Math.log10(r)) : exp;    // 按结果实际数量级重算小数位
    const decimals = Math.max(0, (sig - 1) - expR);          // 跨位进位后不回填多余 0 (得 0.1 而非 0.10)
    return { text: r.toFixed(decimals), decimals };
}
// 四舍六入五成双 (round-half-to-even): 修约到 decimals 位小数; 被舍去部分 <半舍去、>半进一、恰好半则末位取偶(奇进偶舍)。
// 1e-9 容差吸收浮点噪声 (如 25.65×10=256.49999… 视为恰好半)。均值 R̄ 为正, 无需处理负号方向。
function roundHalfEven(x, decimals) {
    const f = Math.pow(10, decimals);
    const scaled = x * f;
    const floor = Math.floor(scaled);
    const frac = scaled - floor;
    let n;
    if (Math.abs(frac - 0.5) < 1e-9) n = (floor % 2 === 0) ? floor : floor + 1;  // 五成双: 末位奇进偶舍
    else n = (frac > 0.5) ? floor + 1 : floor;                                    // 四舍六入
    return (n / f).toFixed(decimals);
}

// 计算平均曲率半径的不确定度 (按五步评定): B类(仪器误差) → B类相对 → A类(多组) → 合成 → 扩展
// radiusData: calculateRadiusData 结果 (含 Dm/Dn/diffSquared, mm / mm²); averageRadius: 均值 R̄ (m)
export function calculateRadiusUncertainty(radiusData, averageRadius, pixelScale) {
    const k = radiusData?.length || 0;
    if (k === 0 || !(averageRadius > 0)) return null;

    // 1. 直径 D 的 B 类: 一次直径读 2 次显微镜刻度 (左、右), 单次示值误差限 Δ 按正态分布取 p=0.683、包含因子 k=1
    const uBx = INSTRUMENT_ERROR / 1;                          // 单次读数 u_B(x) = Δ/k = Δ/1 = Δ (p=0.683, k=1)
    const uBD = Math.sqrt(2) * uBx;                            // 直径为两次读数之差 u_B(D) = √2·u_B(x) = √2·Δ

    // 2. R 的 B 类相对不确定度 (逐组): u_B(R)/R = 2·u_B(D)/(Dm²−Dn²)·√(Dm²+Dn²), u_B(R)_i = R_i·rel
    const perGroup = radiusData
        .filter(it => (it.m - it.n) > 0 && it.diffSquared > 0)
        .map(it => {
            const Dm = it.Dm || 0, Dn = it.Dn || 0;
            const rel = (2 * uBD / it.diffSquared) * Math.sqrt(Dm * Dm + Dn * Dn);
            return { group: it.group, m: it.m, n: it.n, Dm, Dn, diffSq: it.diffSquared, rel, uBR: (it.radiusRounded ?? it.radius) * rel };
        });
    const uBRel = perGroup.length ? perGroup.reduce((a, g) => a + g.rel, 0) / perGroup.length : 0;
    const uB = averageRadius * uBRel;                          // u_B(R) = R̄·(u_B(R)/R)

    // 3. A 类不确定度 (多组 R_i): u_A(R̄) = √[Σ(R_i−R̄)²/(k(k−1))], 自由度 ν_A = k−1
    let s = 0, uA = 0, sumSqDev = 0, nuA = 0;
    if (k >= 2) {
        sumSqDev = radiusData.reduce((sum, it) => sum + Math.pow((it.radiusRounded ?? it.radius) - averageRadius, 2), 0);
        uA = Math.sqrt(sumSqDev / (k * (k - 1)));
        s = Math.sqrt(sumSqDev / (k - 1));
        nuA = k - 1;
    }

    // 4. 合成标准不确定度 u_C(R) = √[u_A²(R̄) + u_B²(R)]
    const uC = Math.sqrt(uA * uA + uB * uB);

    // 5. 扩展不确定度 (p=0.683, k=1): U = k·u_C = u_C。ν_eff (Welch–Satterthwaite, B类视为系统 ν_B→∞) 仅作自由度参考, 不再决定包含因子
    let nuEff = Infinity;
    if (uA > 0 && uC > 0) nuEff = Math.pow(uC, 4) / (Math.pow(uA, 4) / nuA);
    const U = uC;                                              // 包含因子 k=1 (p=0.683, 正态 1σ) → U = u_C
    const relative = averageRadius > 0 ? U / averageRadius : 0;

    const uFmt = sigU(U);
    const decimals = uFmt.decimals;                          // U 修约后的实际小数位, 供均值四舍六入五成双对齐
    return {
        valid: uC > 0 && isFinite(uC),
        k, mean: averageRadius,
        deltaInstrument: INSTRUMENT_ERROR, uBx, uBD, perGroup, uBRel, uB,
        s, sumSqDev, uA, nuA,
        uC, nuEff, U, relative,
        meanText: roundHalfEven(averageRadius, decimals),    // R̄ 四舍六入五成双对齐 U 末位 (最佳估计值, 不套用只进不舍)
        uText: uFmt.text,                                    // U: 只进不舍修约值 (不再用 toFixed 四舍五入)
        uAText: sigU(uA).text,
        uBText: sigU(uB).text,
        uCText: sigU(uC).text,
        uBxText: uBx.toFixed(6),
        uBDText: uBD.toFixed(6),
        nuEffText: isFinite(nuEff) ? nuEff.toFixed(1) : '∞',
        kText: '1',                                          // 包含因子 k=1 (p=0.683)
        relativeText: sigU(relative * 100).text + '%'        // 相对不确定度: 精确比值 → 同规则(只进不舍)修约 → 百分比
    };
}
