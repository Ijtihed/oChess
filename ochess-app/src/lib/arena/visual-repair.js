/**
 * Deterministic visual repair for AI Arena variants.
 *
 * Prompting Gemini to emit beautiful visuals is necessary, but
 * not sufficient. Models can omit `rules.visuals`, use a
 * projectile key that doesn't match the ability id, or emit one
 * weak aura when the gameplay clearly needs a fireball /
 * frost-shard / impact animation.
 *
 * This repair pass is NOT a generic fallback library. It derives
 * visuals from the actual AI-generated mechanics:
 *   - ability id / label
 *   - caster piece type
 *   - effect kind / tag
 *
 * It never changes rules, moves, effects, cooldowns, or win
 * conditions. It only fills missing visual keys so every active
 * ability has something concrete to render.
 */

const PIECES = ["p", "n", "b", "r", "q", "k"];

export function repairVisualsForRules(rules) {
  if (!rules || typeof rules !== "object") return rules;
  const additions = buildVisualRepairs(rules);
  if (!hasVisualContent(additions)) return rules;
  return {
    ...rules,
    visuals: mergeVisualBlocks(rules.visuals, additions),
  };
}

export function buildVisualRepairs(rules) {
  const out = { slots: {}, projectiles: {}, effects: {}, overlays: [], brains: {} };
  const abilities = collectAbilities(rules);
  const themes = new Set();

  for (const item of abilities) {
    const { pieceType, ability } = item;
    if (!ability?.id) continue;
    const theme = classifyAbilityTheme(ability);
    themes.add(theme);
    addThemeForPiece(out, pieceType, theme);
    out.projectiles[ability.id] = projectileSourceForTheme(theme);
  }

  // Shared effect draw sources used by the repair brains and
  // overlays. Only include what we need.
  if (themes.has("fire")) {
    out.effects.fire_ember = FIRE_EMBER_EFFECT;
    out.effects.fire_impact = FIRE_IMPACT_EFFECT;
  }
  if (themes.has("ice")) {
    out.effects.ice_spark = ICE_SPARK_EFFECT;
  }
  if (themes.has("shadow")) {
    out.effects.shadow_wisp = SHADOW_WISP_EFFECT;
  }
  if (themes.has("impact")) {
    out.effects.impact_spark = IMPACT_SPARK_EFFECT;
  }
  if (themes.size > 0) {
    out.overlays.push(LAST_CAST_OVERLAY);
    out.overlays.push(MARK_STATUS_OVERLAY);
  }
  return out;
}

function collectAbilities(rules) {
  const out = [];
  const scanPieceMap = (pieceMap) => {
    if (!pieceMap || typeof pieceMap !== "object") return;
    for (const pt of PIECES) {
      const spec = pieceMap[pt];
      if (!spec || typeof spec !== "object" || !Array.isArray(spec.abilities)) continue;
      for (const ability of spec.abilities) out.push({ pieceType: pt, ability });
    }
  };
  scanPieceMap(rules.pieces);
  if (rules.byColor && typeof rules.byColor === "object") {
    for (const color of ["w", "b"]) {
      const entry = rules.byColor[color];
      if (!entry || typeof entry !== "object") continue;
      scanPieceMap(entry.pieces && typeof entry.pieces === "object" ? entry.pieces : entry);
    }
  }
  // De-dupe by piece+ability id. byColor can duplicate the same
  // ability on top of a base spec.
  const seen = new Set();
  return out.filter(({ pieceType, ability }) => {
    const key = `${pieceType}:${ability?.id || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyAbilityTheme(ability) {
  const text = [
    ability.id,
    ability.label,
    ability.effect?.kind,
    ability.effect?.tag,
    ability.effect?.inner?.kind,
    ability.effect?.inner?.tag,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/fire|flame|burn|ember|inferno|blast|explod|doom/.test(text)) return "fire";
  if (/ice|frost|freeze|frozen|crystal|snow|chill/.test(text)) return "ice";
  if (/shadow|curse|void|dark|doom|hex/.test(text)) return "shadow";
  if (/push|pull|throw|bowl|displace|knock|yeet|impact|slam/.test(text)) return "impact";
  if (/lightning|shock|storm|thunder|zap|electric/.test(text)) return "lightning";
  if (/summon|spawn|necro|raise|ghost|spirit|bone/.test(text)) return "shadow";
  return "magic";
}

function addThemeForPiece(out, pt, theme) {
  if (theme === "fire") {
    out.slots[`${pt}.body`] ||= FIRE_BODY_SLOT;
    out.slots[`${pt}.back`] ||= FIRE_BACK_SLOT;
    out.slots[`${pt}.feet`] ||= FIRE_FEET_SLOT;
    out.slots[`${pt}.aura`] ||= FIRE_AURA_SLOT;
    out.slots[`${pt}.weapon_R`] ||= FIRE_WEAPON_SLOT;
    out.brains[pt] ||= FIRE_BRAIN;
    return;
  }
  if (theme === "ice") {
    out.slots[`${pt}.aura`] ||= ICE_AURA_SLOT;
    out.slots[`${pt}.back`] ||= ICE_BACK_SLOT;
    out.slots[`${pt}.weapon_L`] ||= ICE_WEAPON_SLOT;
    out.slots[`${pt}.feet`] ||= ICE_FEET_SLOT;
    out.brains[pt] ||= ICE_BRAIN;
    return;
  }
  if (theme === "shadow") {
    out.slots[`${pt}.body`] ||= SHADOW_BODY_SLOT;
    out.slots[`${pt}.back`] ||= SHADOW_BACK_SLOT;
    out.slots[`${pt}.aura`] ||= SHADOW_AURA_SLOT;
    out.brains[pt] ||= SHADOW_BRAIN;
    return;
  }
  if (theme === "impact") {
    out.slots[`${pt}.aura`] ||= IMPACT_AURA_SLOT;
    out.slots[`${pt}.weapon_R`] ||= IMPACT_WEAPON_SLOT;
    out.slots[`${pt}.feet`] ||= IMPACT_FEET_SLOT;
    out.brains[pt] ||= IMPACT_BRAIN;
    return;
  }
  if (theme === "lightning") {
    out.slots[`${pt}.aura`] ||= LIGHTNING_AURA_SLOT;
    out.slots[`${pt}.weapon_R`] ||= LIGHTNING_WEAPON_SLOT;
    out.slots[`${pt}.back`] ||= LIGHTNING_BACK_SLOT;
    out.brains[pt] ||= LIGHTNING_BRAIN;
    return;
  }
  out.slots[`${pt}.aura`] ||= MAGIC_AURA_SLOT;
  out.slots[`${pt}.body`] ||= MAGIC_BODY_SLOT;
  out.brains[pt] ||= MAGIC_BRAIN;
}

function projectileSourceForTheme(theme) {
  if (theme === "fire") return FIREBALL_PROJECTILE;
  if (theme === "ice") return ICE_PROJECTILE;
  if (theme === "shadow") return SHADOW_PROJECTILE;
  if (theme === "impact") return IMPACT_PROJECTILE;
  if (theme === "lightning") return LIGHTNING_PROJECTILE;
  return MAGIC_PROJECTILE;
}

function mergeVisualBlocks(existing, additions) {
  const base = existing && typeof existing === "object" ? existing : {};
  const merged = {
    ...base,
    slots: { ...(additions.slots || {}), ...(base.slots || {}) },
    projectiles: { ...(additions.projectiles || {}), ...(base.projectiles || {}) },
    effects: { ...(additions.effects || {}), ...(base.effects || {}) },
    brains: { ...(additions.brains || {}), ...(base.brains || {}) },
  };
  const overlays = [];
  if (Array.isArray(base.overlays)) overlays.push(...base.overlays);
  if (Array.isArray(additions.overlays)) {
    for (const src of additions.overlays) {
      if (!overlays.includes(src)) overlays.push(src);
    }
  }
  if (overlays.length > 0) merged.overlays = overlays;
  return pruneEmptyVisualBlock(merged);
}

function pruneEmptyVisualBlock(v) {
  const out = {};
  for (const key of ["slots", "projectiles", "effects", "brains"]) {
    if (v[key] && Object.keys(v[key]).length > 0) out[key] = v[key];
  }
  if (Array.isArray(v.overlays) && v.overlays.length > 0) out.overlays = v.overlays;
  return out;
}

function hasVisualContent(v) {
  return !!(
    v &&
    ((v.slots && Object.keys(v.slots).length > 0) ||
      (v.projectiles && Object.keys(v.projectiles).length > 0) ||
      (v.effects && Object.keys(v.effects).length > 0) ||
      (v.brains && Object.keys(v.brains).length > 0) ||
      (Array.isArray(v.overlays) && v.overlays.length > 0))
  );
}

// Slots
const FIRE_BODY_SLOT = "const pulse=Math.sin(t*0.012)*0.5+0.5; const g=ctx.createRadialGradient(0,0,2,0,0,22+8*pulse); g.addColorStop(0,'rgba(255,250,180,0.55)'); g.addColorStop(0.45,'rgba(255,100,0,0.35)'); g.addColorStop(1,'rgba(255,0,0,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,24+4*pulse,0,Math.PI*2); ctx.fill();";
const FIRE_BACK_SLOT = "ctx.strokeStyle='rgba(255,80,0,0.45)'; ctx.lineWidth=2; for(let i=0;i<8;i++){ const a=-Math.PI/2+(i-3.5)*0.18+Math.sin(t*0.006+i)*0.08; ctx.beginPath(); ctx.moveTo(Math.cos(a)*8,Math.sin(a)*8); ctx.bezierCurveTo(Math.cos(a)*16,Math.sin(a)*28,Math.cos(a)*24,Math.sin(a)*36,Math.cos(a)*30,Math.sin(a)*44); ctx.stroke(); }";
const FIRE_FEET_SLOT = "ctx.fillStyle='rgba(255,100,0,0.35)'; for(let i=0;i<5;i++){ const a=i*1.256+t*0.004; ctx.beginPath(); ctx.ellipse(Math.cos(a)*10,22+Math.sin(a)*3,4,10,a,0,Math.PI*2); ctx.fill(); }";
const FIRE_AURA_SLOT = "const phase=Math.sin(t*0.007)*0.5+0.5; const r=32+phase*12; const g=ctx.createRadialGradient(0,0,0,0,0,r); g.addColorStop(0,'rgba(255,245,150,0.55)'); g.addColorStop(0.28,'rgba(255,150,0,0.42)'); g.addColorStop(0.65,'rgba(255,20,0,0.22)'); g.addColorStop(1,'rgba(80,0,0,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.fill(); for(let i=0;i<10;i++){ const a=i*0.628+t*0.005; const r1=14+phase*4; const r2=34+Math.sin(t*0.01+i)*7; ctx.strokeStyle='rgba(255,120,0,0.75)'; ctx.lineWidth=1.4; ctx.beginPath(); ctx.moveTo(Math.cos(a)*r1,Math.sin(a)*r1); ctx.lineTo(Math.cos(a+0.12)*r2,Math.sin(a+0.12)*r2); ctx.stroke(); }";
const FIRE_WEAPON_SLOT = "ctx.save(); ctx.rotate(0.35*facing); const flick=Math.sin(t*0.018)*5; ctx.strokeStyle='rgba(100,38,0,0.95)'; ctx.lineWidth=4; ctx.beginPath(); ctx.moveTo(8*facing,-18); ctx.lineTo(24*facing,-1); ctx.stroke(); const g=ctx.createRadialGradient(28*facing,-1,0,28*facing,-1,15+flick); g.addColorStop(0,'rgba(255,255,200,1)'); g.addColorStop(0.32,'rgba(255,145,0,0.95)'); g.addColorStop(0.72,'rgba(255,20,0,0.55)'); g.addColorStop(1,'rgba(255,0,0,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(28*facing,-1,15+flick,0,Math.PI*2); ctx.fill(); for(let i=0;i<4;i++){ const a=-1.2+i*0.55+t*0.006; ctx.strokeStyle='rgba(255,210,60,0.7)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(24*facing,-1); ctx.lineTo(24*facing+Math.cos(a)*18*facing,-1+Math.sin(a)*18); ctx.stroke(); } ctx.restore();";
const ICE_AURA_SLOT = "const pulse=Math.sin(t*0.003)*0.5+0.5; ctx.strokeStyle='rgba(170,230,255,'+(0.45+pulse*0.25)+')'; ctx.lineWidth=1.5; for(let i=0;i<8;i++){ const a=i*Math.PI/4; const r1=12; const r2=26+pulse*4; ctx.beginPath(); ctx.moveTo(Math.cos(a)*r1,Math.sin(a)*r1); ctx.lineTo(Math.cos(a)*r2,Math.sin(a)*r2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(Math.cos(a)*r2,Math.sin(a)*r2); ctx.lineTo(Math.cos(a+0.22)*(r2-7),Math.sin(a+0.22)*(r2-7)); ctx.moveTo(Math.cos(a)*r2,Math.sin(a)*r2); ctx.lineTo(Math.cos(a-0.22)*(r2-7),Math.sin(a-0.22)*(r2-7)); ctx.stroke(); }";
const ICE_BACK_SLOT = "ctx.fillStyle='rgba(180,240,255,0.20)'; for(let i=0;i<4;i++){ const a=t*0.001+i*Math.PI/2; ctx.beginPath(); ctx.ellipse(Math.cos(a)*12,Math.sin(a)*8-6,5,14,a,0,Math.PI*2); ctx.fill(); }";
const ICE_WEAPON_SLOT = "ctx.save(); ctx.rotate(-0.35*facing); ctx.fillStyle='rgba(180,240,255,0.75)'; ctx.beginPath(); ctx.moveTo(22*facing,-12); ctx.lineTo(8*facing,-2); ctx.lineTo(17*facing,2); ctx.lineTo(7*facing,12); ctx.lineTo(28*facing,0); ctx.closePath(); ctx.fill(); ctx.strokeStyle='rgba(80,180,255,0.7)'; ctx.lineWidth=1; ctx.stroke(); ctx.restore();";
const ICE_FEET_SLOT = "ctx.strokeStyle='rgba(180,240,255,0.45)'; ctx.lineWidth=1; for(let i=0;i<4;i++){ const x=-14+i*9; ctx.beginPath(); ctx.moveTo(x,24); ctx.lineTo(x+5,18); ctx.lineTo(x+10,24); ctx.stroke(); }";
const SHADOW_BODY_SLOT = "const pulse=Math.sin(t*0.003)*0.5+0.5; const g=ctx.createRadialGradient(0,0,0,0,0,32+8*pulse); g.addColorStop(0,'rgba(160,70,255,0.36)'); g.addColorStop(0.45,'rgba(70,0,120,0.34)'); g.addColorStop(1,'rgba(10,0,30,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.ellipse(0,2,25,32,Math.sin(t*0.001)*0.2,0,Math.PI*2); ctx.fill();";
const SHADOW_BACK_SLOT = "for(let i=0;i<7;i++){ const a=t*0.001+i*0.897; ctx.fillStyle='rgba(120,30,190,0.20)'; ctx.beginPath(); ctx.ellipse(Math.cos(a)*18,Math.sin(a)*10,11,30,a,0,Math.PI*2); ctx.fill(); ctx.strokeStyle='rgba(190,110,255,0.28)'; ctx.lineWidth=1; ctx.stroke(); }";
const SHADOW_AURA_SLOT = "const a=Math.sin(t*0.002)*0.5+0.5; for(let i=0;i<7;i++){ const ang=i*0.897+t*0.0015; ctx.fillStyle='rgba(95,0,150,'+(0.18+a*0.18)+')'; ctx.beginPath(); ctx.ellipse(Math.cos(ang)*14,Math.sin(ang)*10,14+i,26,ang,0,Math.PI*2); ctx.fill(); } ctx.strokeStyle='rgba(210,120,255,0.55)'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.arc(0,0,31+a*5,0,Math.PI*2); ctx.stroke();";
const IMPACT_AURA_SLOT = "const pulse=Math.sin(t*0.01)*0.5+0.5; ctx.strokeStyle='rgba(255,220,110,0.65)'; ctx.lineWidth=2.5; for(let i=0;i<8;i++){ const a=i*Math.PI/4+t*0.002; ctx.beginPath(); ctx.moveTo(Math.cos(a)*10,Math.sin(a)*10); ctx.lineTo(Math.cos(a)*(30+pulse*8),Math.sin(a)*(30+pulse*8)); ctx.stroke(); } ctx.fillStyle='rgba(170,110,45,0.18)'; ctx.beginPath(); ctx.arc(0,0,30+pulse*5,0,Math.PI*2); ctx.fill();";
const IMPACT_WEAPON_SLOT = "ctx.strokeStyle='rgba(120,80,25,0.98)'; ctx.lineWidth=7; ctx.lineCap='round'; ctx.beginPath(); ctx.moveTo(6*facing,-18); ctx.lineTo(25*facing,9); ctx.stroke(); const g=ctx.createRadialGradient(29*facing,12,0,29*facing,12,16); g.addColorStop(0,'rgba(255,230,130,0.9)'); g.addColorStop(1,'rgba(160,95,30,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(29*facing,12,16,0,Math.PI*2); ctx.fill();";
const IMPACT_FEET_SLOT = "ctx.fillStyle='rgba(160,110,45,0.38)'; for(let i=0;i<7;i++){ ctx.fillRect(-28+i*9,22+(i%2)*4,8,4); } ctx.strokeStyle='rgba(255,220,110,0.35)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(-26,26); ctx.lineTo(26,26); ctx.stroke();";
const LIGHTNING_AURA_SLOT = "ctx.strokeStyle='rgba(170,240,255,0.65)'; ctx.lineWidth=1.5; for(let i=0;i<5;i++){ const a=i*1.256+t*0.01; ctx.beginPath(); ctx.moveTo(Math.cos(a)*10,Math.sin(a)*10); ctx.lineTo(Math.cos(a+0.3)*22,Math.sin(a+0.3)*22); ctx.lineTo(Math.cos(a-0.2)*30,Math.sin(a-0.2)*30); ctx.stroke(); }";
const LIGHTNING_WEAPON_SLOT = "ctx.strokeStyle='rgba(210,255,255,0.85)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(8*facing,-18); ctx.lineTo(18*facing,-6); ctx.lineTo(12*facing,-4); ctx.lineTo(26*facing,12); ctx.stroke();";
const LIGHTNING_BACK_SLOT = "ctx.strokeStyle='rgba(120,220,255,0.35)'; ctx.lineWidth=1.5; for(let i=0;i<6;i++){ const x=-24+i*9; ctx.beginPath(); ctx.moveTo(x,-22); ctx.lineTo(x+5,-8); ctx.lineTo(x+1,-7); ctx.lineTo(x+8,8); ctx.stroke(); }";
const MAGIC_BODY_SLOT = "const g=ctx.createRadialGradient(0,0,0,0,0,25); g.addColorStop(0,'rgba(210,190,255,0.22)'); g.addColorStop(1,'rgba(90,60,255,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,25,0,Math.PI*2); ctx.fill();";
const MAGIC_AURA_SLOT = "const r=22+Math.sin(t*0.004)*5; const g=ctx.createRadialGradient(0,0,0,0,0,r); g.addColorStop(0,'rgba(140,110,255,0.28)'); g.addColorStop(1,'rgba(140,110,255,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.fill();";

// Brain hooks
const FIRE_BRAIN = "if(!state.nextSpark||state.nextSpark<=0){ world.spawnEffect({kind:'fire_ember',x:self.x+(random()*24-12),y:self.y+(random()*24-12),ttl:500,data:{rise:10+random()*12}}); state.nextSpark=0.25; } state.nextSpark=state.nextSpark-dt;";
const ICE_BRAIN = "if(!state.nextSpark||state.nextSpark<=0){ world.spawnEffect({kind:'ice_spark',x:self.x+(random()*22-11),y:self.y+(random()*22-11),ttl:600,data:{spin:random()*6.28}}); state.nextSpark=0.35; } state.nextSpark=state.nextSpark-dt;";
const SHADOW_BRAIN = "if(!state.nextSpark||state.nextSpark<=0){ world.spawnEffect({kind:'shadow_wisp',x:self.x+(random()*28-14),y:self.y+(random()*20-10),ttl:800,data:{drift:random()*16-8}}); state.nextSpark=0.45; } state.nextSpark=state.nextSpark-dt;";
const IMPACT_BRAIN = "if(!state.nextSpark||state.nextSpark<=0){ world.spawnEffect({kind:'impact_spark',x:self.x+(random()*20-10),y:self.y+(random()*20-10),ttl:350,data:{}}); state.nextSpark=0.4; } state.nextSpark=state.nextSpark-dt;";
const LIGHTNING_BRAIN = "if(!state.nextSpark||state.nextSpark<=0){ world.spawnEffect({kind:'ice_spark',x:self.x+(random()*26-13),y:self.y+(random()*26-13),ttl:250,data:{spin:random()*6.28}}); state.nextSpark=0.18; } state.nextSpark=state.nextSpark-dt;";
const MAGIC_BRAIN = "if(!state.nextSpark||state.nextSpark<=0){ world.spawnEffect({kind:'shadow_wisp',x:self.x+(random()*20-10),y:self.y+(random()*20-10),ttl:650,data:{drift:random()*10-5}}); state.nextSpark=0.55; } state.nextSpark=state.nextSpark-dt;";

// Projectiles
const FIREBALL_PROJECTILE = "const dx=p.toX-p.fromX,dy=p.toY-p.fromY; const len=Math.sqrt(dx*dx+dy*dy)||1; const ux=dx/len,uy=dy/len; for(let i=0;i<14;i++){ const back=i/13; const wob=Math.sin(p.age*0.05+i)*7; const tx=p.x-ux*back*58-uy*wob*(1-back); const ty=p.y-uy*back*58+ux*wob*(1-back); const rad=18*(1-back)+3; ctx.fillStyle='rgba(255,'+(210-i*12)+',0,'+(0.82-back*0.65)+')'; ctx.beginPath(); ctx.arc(tx,ty,rad,0,Math.PI*2); ctx.fill(); } ctx.strokeStyle='rgba(255,240,120,0.8)'; ctx.lineWidth=3; for(let i=0;i<5;i++){ const off=(i-2)*7; ctx.beginPath(); ctx.moveTo(p.x-uy*off,p.y+ux*off); ctx.lineTo(p.x-ux*54-uy*off*0.3,p.y-uy*54+ux*off*0.3); ctx.stroke(); } const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,26); g.addColorStop(0,'rgba(255,255,220,1)'); g.addColorStop(0.3,'rgba(255,175,0,0.95)'); g.addColorStop(0.72,'rgba(255,35,0,0.65)'); g.addColorStop(1,'rgba(255,0,0,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(p.x,p.y,26,0,Math.PI*2); ctx.fill();";
const ICE_PROJECTILE = "const dx=p.toX-p.fromX,dy=p.toY-p.fromY; const a=Math.atan2(dy,dx); ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(a); ctx.fillStyle='rgba(190,240,255,0.92)'; ctx.beginPath(); ctx.moveTo(16,0); ctx.lineTo(-10,-6); ctx.lineTo(-3,0); ctx.lineTo(-10,6); ctx.closePath(); ctx.fill(); ctx.strokeStyle='rgba(80,180,255,0.65)'; ctx.lineWidth=1; ctx.stroke(); ctx.restore();";
const SHADOW_PROJECTILE = "const a=0.55+0.25*Math.sin(p.progress*6.28); const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,24); g.addColorStop(0,'rgba(210,140,255,'+a+')'); g.addColorStop(0.45,'rgba(95,0,150,'+(a*0.75)+')'); g.addColorStop(1,'rgba(20,0,40,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.ellipse(p.x,p.y,26,14,p.progress*6.28,0,Math.PI*2); ctx.fill(); ctx.strokeStyle='rgba(230,170,255,0.55)'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(p.x,p.y,21,0,Math.PI*2); ctx.stroke();";
const IMPACT_PROJECTILE = "const dx=p.toX-p.fromX,dy=p.toY-p.fromY; const len=Math.sqrt(dx*dx+dy*dy)||1; const ux=dx/len,uy=dy/len; ctx.strokeStyle='rgba(255,220,120,0.85)'; ctx.lineWidth=8; ctx.lineCap='round'; ctx.beginPath(); ctx.moveTo(p.x-ux*54,p.y-uy*54); ctx.lineTo(p.x,p.y); ctx.stroke(); for(let i=0;i<8;i++){ const back=i/8; ctx.fillStyle='rgba(175,115,45,'+(0.55-back*0.45)+')'; ctx.beginPath(); ctx.arc(p.x-ux*back*48-uy*(i-4)*3,p.y-uy*back*48+ux*(i-4)*3,10-back*6,0,Math.PI*2); ctx.fill(); } ctx.fillStyle='rgba(255,235,150,0.95)'; ctx.beginPath(); ctx.arc(p.x,p.y,13,0,Math.PI*2); ctx.fill();";
const LIGHTNING_PROJECTILE = "const dx=p.toX-p.fromX,dy=p.toY-p.fromY; ctx.strokeStyle='rgba(180,245,255,0.9)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(p.fromX,p.fromY); for(let i=1;i<=5;i++){ const q=i/5; const x=p.fromX+dx*q+(Math.sin(q*40+p.age*0.04))*5; const y=p.fromY+dy*q+(Math.cos(q*37+p.age*0.04))*5; ctx.lineTo(x,y); } ctx.stroke();";
const MAGIC_PROJECTILE = "const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,11); g.addColorStop(0,'rgba(220,200,255,0.9)'); g.addColorStop(1,'rgba(100,60,255,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(p.x,p.y,11,0,Math.PI*2); ctx.fill();";

// Effects
const FIRE_EMBER_EFFECT = "const a=1-e.progress; const rise=e.data&&e.data.rise?e.data.rise:14; ctx.fillStyle='rgba(255,120,0,'+a+')'; ctx.beginPath(); ctx.arc(e.x,e.y-rise*e.progress,2+2*(1-e.progress),0,Math.PI*2); ctx.fill();";
const FIRE_IMPACT_EFFECT = "const a=1-e.progress; const r=10+e.progress*55; const g=ctx.createRadialGradient(e.x,e.y,0,e.x,e.y,r); g.addColorStop(0,'rgba(255,240,150,'+(0.7*a)+')'); g.addColorStop(0.4,'rgba(255,90,0,'+(0.45*a)+')'); g.addColorStop(1,'rgba(255,0,0,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(e.x,e.y,r,0,Math.PI*2); ctx.fill(); ctx.strokeStyle='rgba(255,170,0,'+(0.9*a)+')'; ctx.lineWidth=4; ctx.beginPath(); ctx.arc(e.x,e.y,r*0.75,0,Math.PI*2); ctx.stroke();";
const ICE_SPARK_EFFECT = "const a=1-e.progress; const spin=e.data&&e.data.spin?e.data.spin:0; ctx.strokeStyle='rgba(180,240,255,'+a+')'; ctx.lineWidth=1.5; for(let i=0;i<6;i++){ const ang=spin+i*Math.PI/3; ctx.beginPath(); ctx.moveTo(e.x,e.y); ctx.lineTo(e.x+Math.cos(ang)*(5+e.progress*14),e.y+Math.sin(ang)*(5+e.progress*14)); ctx.stroke(); }";
const SHADOW_WISP_EFFECT = "const a=1-e.progress; const drift=e.data&&e.data.drift?e.data.drift:0; ctx.fillStyle='rgba(95,0,150,'+(0.38*a)+')'; ctx.beginPath(); ctx.ellipse(e.x+drift*e.progress,e.y-18*e.progress,12+12*e.progress,8+16*e.progress,e.progress*3,0,Math.PI*2); ctx.fill();";
const IMPACT_SPARK_EFFECT = "const a=1-e.progress; ctx.strokeStyle='rgba(255,225,120,'+a+')'; ctx.lineWidth=3; for(let i=0;i<12;i++){ const ang=i*Math.PI/6; ctx.beginPath(); ctx.moveTo(e.x+Math.cos(ang)*5,e.y+Math.sin(ang)*5); ctx.lineTo(e.x+Math.cos(ang)*(9+e.progress*28),e.y+Math.sin(ang)*(9+e.progress*28)); ctx.stroke(); }";

// Overlay. Uses ability id text at runtime so repaired visuals
// work for old variants too.
const LAST_CAST_OVERLAY = "const c=scene.lastCast; if(c&&c.to){ const files='abcdefgh'; const f=files.indexOf(c.to[0]); const r=parseInt(c.to[1],10)-1; if(f>=0){ const sq=scene.width/8; const x=f*sq+sq/2; const y=(7-r)*sq+sq/2; const id=String(c.abilityId||'').toLowerCase(); const age=(scene.t%520)/520; let col='rgba(160,110,255,'; if(id.indexOf('fire')>=0||id.indexOf('burn')>=0||id.indexOf('blast')>=0) col='rgba(255,90,0,'; if(id.indexOf('ice')>=0||id.indexOf('frost')>=0||id.indexOf('freeze')>=0) col='rgba(160,230,255,'; if(id.indexOf('shadow')>=0||id.indexOf('curse')>=0) col='rgba(120,40,180,'; ctx.strokeStyle=col+(0.55*(1-age))+')'; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(x,y,12+age*38,0,Math.PI*2); ctx.stroke(); } }";

const MARK_STATUS_OVERLAY = "const sq=scene.width/8; const files='abcdefgh'; const marks=scene.marks||{}; const entries=Object.entries(marks); for(const entry of entries){ const key=entry[0]; const arr=entry[1]||[]; let tag=''; for(const mark of arr){ tag=tag+' '+String(mark.tag||''); } tag=tag.toLowerCase(); const f=files.indexOf(key[0]); const r=parseInt(key[1],10)-1; if(f<0||!tag) continue; const x=f*sq+sq/2,y=(7-r)*sq+sq/2; if(tag.indexOf('freeze')>=0||tag.indexOf('frost')>=0||tag.indexOf('ice')>=0){ ctx.strokeStyle='rgba(170,235,255,0.8)'; ctx.lineWidth=2; for(let i=0;i<10;i++){ const a=i*Math.PI/5+scene.t*0.002; ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+Math.cos(a)*30,y+Math.sin(a)*30); ctx.stroke(); } } else if(tag.indexOf('burn')>=0||tag.indexOf('fire')>=0||tag.indexOf('doom')>=0){ const flick=Math.sin(scene.t*0.018)*0.5+0.5; const g=ctx.createRadialGradient(x,y,0,x,y,42+flick*10); g.addColorStop(0,'rgba(255,230,100,0.55)'); g.addColorStop(0.42,'rgba(255,90,0,0.38)'); g.addColorStop(1,'rgba(255,0,0,0)'); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x,y,44,0,Math.PI*2); ctx.fill(); } else if(tag.indexOf('curse')>=0||tag.indexOf('shadow')>=0||tag.indexOf('hex')>=0){ ctx.fillStyle='rgba(80,0,120,0.28)'; ctx.beginPath(); ctx.ellipse(x,y,34,22,scene.t*0.001,0,Math.PI*2); ctx.fill(); } }";
