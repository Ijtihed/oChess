/**
 * Glicko-2 rating system for oChess.
 * Implements the full Glicko-2 algorithm for 1v1 rating updates.
 */

const TAU = 0.5;
const EPSILON = 0.000001;
const SCALE = 173.7178;

function toGlicko2(rating, rd) {
  return { mu: (rating - 1500) / SCALE, phi: rd / SCALE };
}

function fromGlicko2(mu, phi) {
  return { rating: mu * SCALE + 1500, rd: phi * SCALE };
}

function g(phi) {
  return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));
}

function E(mu, muJ, phiJ) {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

export function computeGlicko2(playerRating, playerRd, playerVol, opponentRating, opponentRd, score) {
  if (!Number.isFinite(playerRating)) playerRating = 1500;
  if (!Number.isFinite(playerRd) || playerRd <= 0) playerRd = 350;
  if (!Number.isFinite(playerVol) || playerVol <= 0) playerVol = 0.06;
  if (!Number.isFinite(opponentRating)) opponentRating = 1500;
  if (!Number.isFinite(opponentRd) || opponentRd <= 0) opponentRd = 350;
  if (!Number.isFinite(score)) score = 0.5;
  const player = toGlicko2(playerRating, playerRd);
  const opp = toGlicko2(opponentRating, opponentRd);
  const sigma = playerVol;

  const gPhiJ = g(opp.phi);
  const eVal = E(player.mu, opp.mu, opp.phi);
  const v = 1 / (gPhiJ * gPhiJ * eVal * (1 - eVal));
  const delta = v * gPhiJ * (score - eVal);

  let a = Math.log(sigma * sigma);
  const f = (x) => {
    const ex = Math.exp(x);
    const d2 = delta * delta;
    const p2 = player.phi * player.phi;
    const num1 = ex * (d2 - p2 - v - ex);
    const den1 = 2 * (p2 + v + ex) * (p2 + v + ex);
    return num1 / den1 - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B;
  if (delta * delta > player.phi * player.phi + v) {
    B = Math.log(delta * delta - player.phi * player.phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100; i++) {
    if (Math.abs(B - A) < EPSILON) break;
    const C = A + (A - B) * fA / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; }
    else { fA = fA / 2; }
    B = C; fB = fC;
  }

  const newSigma = Math.exp(B / 2);
  const phiStar = Math.sqrt(player.phi * player.phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = player.mu + newPhi * newPhi * gPhiJ * (score - eVal);

  const result = fromGlicko2(newMu, newPhi);
  return {
    rating: Math.round(result.rating * 10) / 10,
    rd: Math.round(result.rd * 10) / 10,
    volatility: Math.round(newSigma * 1000000) / 1000000,
    change: Math.round((result.rating - playerRating) * 10) / 10,
  };
}

export function categoryFromTimeControl(tc) {
  if (!tc) return "blitz";
  const match = tc.match(/^(\d+)\+(\d+)$/);
  if (!match) return "blitz";
  const base = parseInt(match[1]);
  const inc = parseInt(match[2]);
  const total = base * 60 + inc * 40;
  if (total < 180) return "bullet";
  if (total < 480) return "blitz";
  if (total < 1500) return "rapid";
  return "classical";
}
