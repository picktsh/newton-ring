import { LAMBDA, INSTRUMENT_ERROR } from './constants.js';

// 计算各暗环直径数据
export function calculateDiameterData(detectedRings, pixelScale) {
    if (!detectedRings || detectedRings.length === 0) {
        return [];
    }
    return detectedRings.map(ring => ({
        number: ring.number,
        diameterPixel: ring.avgRadius * 2,
        diameterMM: ring.avgRadius * 2 * pixelScale
    }));
}

// 计算曲率半径 (使用逐差法，步长 m-n 可人工调节，默认 3)
export function calculateRadiusData(detectedRings, pixelScale, step = 3) {
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
            const Dm = ringM.avgRadius * 2 * pixelScale;
            const Dn = ringN.avgRadius * 2 * pixelScale;
            // R = (Dm² - Dn²) / [4(m-n)λ]
            const diffSquared = Math.pow(Dm, 2) - Math.pow(Dn, 2);
            const R = (diffSquared * 1e-6) / (4 * (group.m - group.n) * LAMBDA);

            results.push({
                group: `D${group.m} 与 D${group.n}`,
                m: group.m,
                n: group.n,
                Dm,
                Dn,
                diffSquared,
                radius: R
            });
            totalRadius += R;
            validGroups++;
        }
    });

    return results;
}

// 动态生成分组配置 (步长可调，默认 3)
function generateDynamicGroups(maxRingNumber, step = 3) {
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

// 计算平均曲率半径
export function calculateAverageRadius(radiusData) {
    if (!radiusData || radiusData.length === 0) {
        return 0;
    }
    const total = radiusData.reduce((sum, item) => sum + item.radius, 0);
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
// t 分布临界值 t₀.₉₅(ν) (双尾, P=0.95), 自由度 ν=1..30; ν>30 或 ν→∞ 取正态 1.96
const T_TABLE_95 = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042
];
function tFactor95(nu) {
    if (!isFinite(nu) || nu >= 30 || nu <= 0) return 1.96;   // ν→∞ (B类主导) 或异常时取正态
    const idx = Math.max(1, Math.floor(nu));                 // 向下取整 (偏保守, t 略大)
    return T_TABLE_95[idx - 1];
}
// 保留 2 位有效数字, 返回字符串与对应小数位 (用于均值/不确定度对齐显示)
function sig2(x) {
    if (!isFinite(x) || x === 0) return { text: '0', decimals: 0 };
    const exp = Math.floor(Math.log10(Math.abs(x)));
    const decimals = Math.max(0, 1 - exp);                   // 2 位有效 → 小数位 = 1 − 数量级
    return { text: x.toFixed(decimals), decimals };
}

// 计算平均曲率半径的不确定度 (按五步评定): B类(仪器误差) → B类相对 → A类(多组) → 合成 → 扩展
// radiusData: calculateRadiusData 结果 (含 Dm/Dn/diffSquared, mm / mm²); averageRadius: 均值 R̄ (m)
export function calculateRadiusUncertainty(radiusData, averageRadius, pixelScale) {
    const k = radiusData?.length || 0;
    if (k === 0 || !(averageRadius > 0)) return null;

    // 1. 直径 D 的 B 类: 一次直径读 2 次显微镜刻度 (左、右), 单次示值误差限 Δ 均匀分布
    const uBx = INSTRUMENT_ERROR / Math.sqrt(3);               // 单次读数 u_B(x) = Δ/√3
    const uBD = Math.sqrt(2) * uBx;                            // 直径为两次读数之差 u_B(D) = √2·Δ/√3

    // 2. R 的 B 类相对不确定度 (逐组): u_B(R)/R = 2·u_B(D)/(Dm²−Dn²)·√(Dm²+Dn²), u_B(R)_i = R_i·rel
    const perGroup = radiusData
        .filter(it => (it.m - it.n) > 0 && it.diffSquared > 0)
        .map(it => {
            const Dm = it.Dm || 0, Dn = it.Dn || 0;
            const rel = (2 * uBD / it.diffSquared) * Math.sqrt(Dm * Dm + Dn * Dn);
            return { group: it.group, m: it.m, n: it.n, Dm, Dn, diffSq: it.diffSquared, rel, uBR: it.radius * rel };
        });
    const uBRel = perGroup.length ? perGroup.reduce((a, g) => a + g.rel, 0) / perGroup.length : 0;
    const uB = averageRadius * uBRel;                          // u_B(R) = R̄·(u_B(R)/R)

    // 3. A 类不确定度 (多组 R_i): u_A(R̄) = √[Σ(R_i−R̄)²/(k(k−1))], 自由度 ν_A = k−1
    let s = 0, uA = 0, sumSqDev = 0, nuA = 0;
    if (k >= 2) {
        sumSqDev = radiusData.reduce((sum, it) => sum + Math.pow(it.radius - averageRadius, 2), 0);
        uA = Math.sqrt(sumSqDev / (k * (k - 1)));
        s = Math.sqrt(sumSqDev / (k - 1));
        nuA = k - 1;
    }

    // 4. 合成标准不确定度 u_C(R) = √[u_A²(R̄) + u_B²(R)]
    const uC = Math.sqrt(uA * uA + uB * uB);

    // 5. 扩展不确定度 (P=0.95): 有效自由度 Welch–Satterthwaite (B类视为系统 ν_B→∞), U = k·u_C
    let nuEff = Infinity;
    if (uA > 0 && uC > 0) nuEff = Math.pow(uC, 4) / (Math.pow(uA, 4) / nuA);
    const kFactor = tFactor95(nuEff);
    const U = kFactor * uC;
    const relative = averageRadius > 0 ? U / averageRadius : 0;

    const uFmt = sig2(U);
    const decimals = uFmt.decimals;
    return {
        valid: uC > 0 && isFinite(uC),
        k, mean: averageRadius,
        deltaInstrument: INSTRUMENT_ERROR, uBx, uBD, perGroup, uBRel, uB,
        s, sumSqDev, uA, nuA,
        uC, nuEff, kFactor, U, relative,
        meanText: averageRadius.toFixed(decimals),
        uText: U.toFixed(decimals),
        uAText: sig2(uA).text,
        uBText: sig2(uB).text,
        uCText: sig2(uC).text,
        uBxText: uBx.toFixed(6),
        uBDText: uBD.toFixed(6),
        nuEffText: isFinite(nuEff) ? nuEff.toFixed(1) : '∞',
        kText: kFactor.toFixed(2),
        relativeText: (relative * 100).toFixed(2) + '%'
    };
}
