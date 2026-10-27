'use strict';
/**
 * LANDSAFE AI — Explainable Landslide Susceptibility & Early-Warning Model
 * 
 * Based on empirical rainfall intensity-duration thresholds (Caine 1980, Guzzetti et al. 2007)
 * and infinite slope pore-pressure stability principles (Terzaghi / Skempton).
 * 
 * Factors evaluated:
 *  1. Antecedent Rainfall (24h accumulation vs. slope-calibrated critical threshold)
 *  2. Volumetric Soil Moisture (pore-water pressure and plastic limit saturation)
 *  3. InSAR Ground Deformation (Sentinel-1 12-day line-of-sight surface displacement)
 *  4. GIS Terrain Susceptibility (Copernicus DEM slope angle, historical NASA GLC events, road cuttings)
 *  5. Citizen Ground Truth (verified tension cracks, seepages, rockfalls from field reports)
 */

const RISK_LEVELS = [
  { level: 'LOW', code: 0, min: 0, max: 39, color: '#10b981', symbol: '●', advice: 'No action needed. Slopes are stable under current conditions.' },
  { level: 'MODERATE', code: 1, min: 40, max: 59, color: '#f59e0b', symbol: '▲', advice: 'Be alert. Saturated slopes; avoid unstable road cuttings during heavy showers.' },
  { level: 'HIGH', code: 2, min: 60, max: 79, color: '#f97316', symbol: '■', advice: 'High landslide risk. Avoid steep slope corridors; field teams on standby; SMS advisory sent.' },
  { level: 'CRITICAL', code: 3, min: 80, max: 100, color: '#ef4444', symbol: '✖', advice: 'Critical risk. Imminent slope failure. Evacuate to designated safe shelters immediately.' },
];

/**
 * Calculates slope-adjusted rainfall threshold in mm/24h.
 * Steeper slopes require less rainfall to trigger shear failure.
 */
function getRainThreshold(slopeDeg) {
  const slope = Math.max(5, Math.min(60, slopeDeg || 25));
  // Empirical inverse relation: steeper slopes mobilize at lower precipitation thresholds
  return Math.round(Math.max(25, 75 - (slope - 15) * 0.8));
}

/**
 * Computes an explainable risk score (0-100) and structured factor breakdown.
 * @param {Object} zone
 * @param {number} zone.rain - 24h rainfall (mm)
 * @param {number} zone.soil - Volumetric soil moisture (% or % of saturation)
 * @param {number} [zone.insar] - Sentinel-1 ground displacement (mm / 12d)
 * @param {number} [zone.ndvi] - Sentinel-2 vegetation health index (-0.1 to 1.0)
 * @param {number} zone.sl - Slope angle in degrees (Copernicus DEM)
 * @param {number} zone.h - Count of past landslides within 30km (NASA GLC)
 * @param {number} [zone.ex] - Population exposure rating (1-3)
 * @param {number} [zone.inf] - Infrastructure critical exposure rating (1-3)
 * @param {number} [zone.verifiedReports] - Number of verified citizen field reports
 * @param {boolean} [zone.sensorsOnline] - Flag if ground LoRa nodes are online
 * @param {boolean} [zone.satelliteOnline] - Flag if satellite feeds are online
 */
function calculateRisk(zone) {
  const rain = Math.max(0, Number(zone.rain) || 0);
  const soil = Math.max(0, Math.min(100, Number.isFinite(Number(zone.soil)) && zone.soil != null ? Number(zone.soil) : 45));
  const slope = Math.max(3, Math.min(60, Number(zone.sl) || 25));
  const insar = Math.max(0, Number(zone.insar != null ? zone.insar : (slope / 40) * 1.5));
  const ndvi = zone.ndvi != null ? Number(zone.ndvi) : Math.max(0.2, 0.82 - slope * 0.008);
  const pastSlides = Math.max(0, Number(zone.h) || 0);
  const exposure = Math.max(1, Math.min(3, Number(zone.ex) || 1));
  const infra = Math.max(1, Math.min(3, Number(zone.inf) || 1));
  const verifiedReps = Math.max(0, Number(zone.verifiedReports) || 0);

  const rainThreshold = getRainThreshold(slope);
  const reasons = [];

  // 1. Rainfall Dynamic Score (35% base weight)
  const rainRatio = rain / rainThreshold;
  let rainScore = Math.min(1.2, rainRatio) * 35;
  if (rain >= rainThreshold) {
    reasons.push(`24h Rain: ${Math.round(rain)} mm (exceeds critical threshold of ${rainThreshold} mm)`);
  } else if (rain > rainThreshold * 0.7) {
    reasons.push(`24h Rain: ${Math.round(rain)} mm (approaching trigger threshold of ${rainThreshold} mm)`);
  }

  // 2. Soil Moisture Saturation Score (35% base weight)
  // Moisture below 55% is low risk; above 75% pore-pressure creates liquefaction risk
  let soilFactor = 0;
  if (soil > 85) {
    soilFactor = 1.0;
    reasons.push(`Soil saturation: ${Math.round(soil)}% (liquefaction zone >85%)`);
  } else if (soil > 70) {
    soilFactor = 0.75 + (soil - 70) / 15 * 0.25;
    reasons.push(`Soil saturation: ${Math.round(soil)}% (elevated pore pressure)`);
  } else if (soil > 55) {
    soilFactor = 0.4 + (soil - 55) / 15 * 0.35;
  } else {
    soilFactor = Math.max(0.05, (soil / 55) * 0.35);
  }
  const soilScore = soilFactor * 35;

  // 3. InSAR Surface Displacement Score (15% base weight)
  // 0-2mm normal creep; 2-5mm active strain; >5mm critical shear
  let insarScore = 0;
  if (insar >= 6.0) {
    insarScore = 15;
    reasons.push(`Sentinel-1 InSAR: ${insar.toFixed(1)} mm ground displacement (critical slope movement)`);
  } else if (insar >= 2.5) {
    insarScore = 8 + (insar - 2.5) / 3.5 * 7;
    reasons.push(`Sentinel-1 InSAR: ${insar.toFixed(1)} mm displacement (active slope strain)`);
  } else {
    insarScore = (insar / 2.5) * 6;
  }

  // 4. Vegetation / NDVI Vulnerability Score (15% base weight)
  // Low NDVI (< 0.4) indicates bare / disturbed soil prone to erosion
  let vegScore = 0;
  if (ndvi < 0.35) {
    vegScore = 15;
    reasons.push(`Vegetation index (NDVI): ${ndvi.toFixed(2)} (sparse cover, severe erosion vulnerability)`);
  } else if (ndvi < 0.6) {
    vegScore = 7 + (0.6 - ndvi) / 0.25 * 8;
  } else {
    vegScore = Math.max(1, (1 - ndvi) * 10);
  }

  // 5. Static Terrain Multiplier (GIS Elevation, Slope, Past Landslides, Road cuts)
  const slopeWeight = Math.min(1.5, slope / 28);
  const historyWeight = Math.min(1.4, 0.85 + pastSlides * 0.06);
  const infraWeight = 0.9 + (infra + exposure) * 0.05;
  const terrainMultiplier = (slopeWeight * 0.5 + historyWeight * 0.3 + infraWeight * 0.2);

  if (slope >= 35) {
    reasons.push(`Steep terrain: ${Math.round(slope)}° slope (gravitational shear stress elevated)`);
  }
  if (pastSlides >= 4) {
    reasons.push(`High historical susceptibility: ${pastSlides} recorded slides within 30 km`);
  }

  // Base raw score
  const dynamicTotal = rainScore + soilScore + insarScore + vegScore;
  let normalizedScore = Math.round(dynamicTotal * terrainMultiplier);

  // 6. Community Ground Truth Loop
  // Confirmed citizen field reports add real-time physical verification
  let citizenBonus = 0;
  if (verifiedReps > 0) {
    citizenBonus = Math.min(15, verifiedReps * 6);
    normalizedScore += citizenBonus;
    reasons.push(`${verifiedReps} officer-verified field hazard report(s) (+${citizenBonus} pts)`);
  }

  const finalScore = Math.max(5, Math.min(99, normalizedScore));

  // Determine Level (0: Low, 1: Moderate, 2: High, 3: Critical)
  let levelIdx = 0;
  for (let i = RISK_LEVELS.length - 1; i >= 0; i--) {
    if (finalScore >= RISK_LEVELS[i].min) {
      levelIdx = i;
      break;
    }
  }

  const riskInfo = RISK_LEVELS[levelIdx];

  // If no critical reasons were triggered, provide baseline stability summary
  if (reasons.length === 0) {
    reasons.push(`Slope conditions stable (Rainfall ${Math.round(rain)} mm below threshold, soil moisture normal at ${Math.round(soil)}%)`);
  }

  return {
    score: finalScore,
    level: riskInfo.level,
    levelIdx: riskInfo.code,
    color: riskInfo.color,
    symbol: riskInfo.symbol,
    advice: riskInfo.advice,
    thresholds: {
      rainMm24h: Math.round(rain),
      rainThresholdMm: rainThreshold,
      soilMoisturePct: Math.round(soil),
      insarMm12d: +insar.toFixed(1),
      slopeDeg: Math.round(slope),
    },
    breakdown: {
      rainPoints: +rainScore.toFixed(1),
      soilPoints: +soilScore.toFixed(1),
      insarPoints: +insarScore.toFixed(1),
      vegPoints: +vegScore.toFixed(1),
      terrainMultiplier: +terrainMultiplier.toFixed(2),
      citizenBonus,
    },
    reasons,
  };
}

/**
 * Input confidence: how much of the score rests on live/measured inputs versus modelled defaults.
 * rain + soil are live (Open-Meteo / sensors), slope + history come from DEM + NASA GLC,
 * InSAR and NDVI only count when an admin feed supplies them.
 */
const INPUT_WEIGHTS = { rain: 30, soil: 30, slope: 10, history: 10, insar: 10, ndvi: 10 };
function inputConfidence(live = {}, stale = false) {
  let pct = 0;
  for (const k of Object.keys(INPUT_WEIGHTS)) if (live[k]) pct += INPUT_WEIGHTS[k];
  if (stale) pct = Math.min(pct, 50);
  return {
    confidence_pct: pct,
    confidence: pct >= 75 ? 'HIGH' : pct >= 50 ? 'MEDIUM' : 'LOW',
  };
}

/**
 * Scenario validation (NOT a statistical calibration).
 * The NASA Global Landslide Catalog has no per-event rainfall or soil data, so a true hit-rate
 * cannot be computed from it alone. This runs the model on labelled reference scenarios built from
 * published rainfall-threshold behaviour (Caine 1980; Guzzetti 2007) and reports honestly:
 * hits, misses and false alarms. Pass your own events [{name, rain, soil, slope, pastSlides, insar, expect:'alert'|'quiet'}]
 * to validate against measured data.
 */
const REFERENCE_SCENARIOS = [
  { name: 'Extreme monsoon burst, steep gorge', rain: 160, soil: 92, slope: 35, pastSlides: 6, expect: 'alert' },
  { name: 'Sikkim highway, saturated slope', rain: 95, soil: 85, slope: 38, pastSlides: 5, expect: 'alert' },
  { name: 'Road-cut with active creep', rain: 80, soil: 80, slope: 32, pastSlides: 3, insar: 5, expect: 'alert' },
  { name: 'Prolonged heavy rain, moderate slope', rain: 120, soil: 75, slope: 28, pastSlides: 2, expect: 'alert' },
  { name: 'Wet slope, high pore pressure', rain: 70, soil: 88, slope: 40, pastSlides: 4, insar: 4, expect: 'alert' },
  { name: 'Dry season, steep slope', rain: 0, soil: 25, slope: 30, pastSlides: 3, expect: 'quiet' },
  { name: 'Light shower', rain: 10, soil: 40, slope: 35, pastSlides: 2, expect: 'quiet' },
  { name: 'Moderate rain, gentle slope', rain: 25, soil: 55, slope: 25, pastSlides: 1, expect: 'quiet' },
  { name: 'Wet but flat valley floor', rain: 40, soil: 70, slope: 8, pastSlides: 0, expect: 'quiet' },
  { name: 'Moderate rain, dry soil, steep', rain: 30, soil: 50, slope: 40, pastSlides: 5, expect: 'quiet' },
  { name: 'Post-monsoon dry spell', rain: 5, soil: 60, slope: 30, pastSlides: 2, expect: 'quiet' },
  { name: 'Steady drizzle, gentle slope', rain: 45, soil: 60, slope: 20, pastSlides: 1, expect: 'quiet' },
];

function runBacktest(events = REFERENCE_SCENARIOS) {
  const list = events.length ? events : REFERENCE_SCENARIOS;
  let hits = 0, misses = 0, falseAlarms = 0, correctQuiet = 0;
  const rows = list.map((e) => {
    const r = calculateRisk({ rain: e.rain, soil: e.soil, sl: e.slope, h: e.pastSlides, insar: e.insar });
    const flagged = r.levelIdx >= 2;
    const want = (e.expect || 'alert') === 'alert';
    if (want && flagged) hits++; else if (want) misses++; else if (flagged) falseAlarms++; else correctQuiet++;
    return { name: e.name, expect: e.expect || 'alert', score: r.score, level: r.level, ok: want === flagged };
  });
  const alerts = hits + misses, quiets = falseAlarms + correctQuiet;
  return {
    status: 'scenario-validation',
    sampleSize: list.length,
    hits, misses, falseAlarms, correctQuiet,
    hitRatePct: alerts ? +((hits / alerts) * 100).toFixed(1) : null,
    falseAlarmRatePct: quiets ? +((falseAlarms / quiets) * 100).toFixed(1) : null,
    scenarios: rows,
    note: 'Reference-scenario check built from published rainfall-threshold behaviour. It tests model consistency, not real-world accuracy; the NASA GLC has no per-event rainfall to calibrate against.',
  };
}

module.exports = {
  RISK_LEVELS,
  getRainThreshold,
  calculateRisk,
  runBacktest,
  inputConfidence,
  REFERENCE_SCENARIOS,
};
