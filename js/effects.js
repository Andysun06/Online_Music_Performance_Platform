/* ============================================================
 * effects.js — 视觉特效（梦幻版）
 *
 *  - 前景画布（#fx）：按键触发的辉光光束、柔光火花、四芒星、
 *    涟漪、漂浮音符与缓缓上升的光球，全部加色混合营造梦境感。
 *  - 背景画布（#fxBg）：微尘 + 大型柔光光斑缓慢漂移（虚化散景）。
 *  - 辉光用预渲染精灵（按色相缓存）而非 shadowBlur，保证 60fps。
 *  音高 -> 色相：按十二音循环取色，黑白键略有明度差异。
 * ============================================================ */
(function () {
  'use strict';

  var settings = { enabled: true, intensity: 1 };

  var fxCanvas = document.getElementById('fx');
  var bgCanvas = document.getElementById('fxBg');
  var fxCtx = fxCanvas.getContext('2d');
  var bgCtx = bgCanvas.getContext('2d');

  var particles = [];
  var dust = [];
  var bokeh = [];
  var running = false;
  var lastT = 0;
  var time = 0;

  function hueFor(midi) { return (midi % 12) * 30 + 190; }

  /* ---------------- 预渲染辉光精灵 ---------------- */

  var glowCache = {};
  var starCache = {};

  function quantHue(hue) { return ((Math.round(hue / 10) * 10) % 360 + 360) % 360; }

  function glowSprite(hue) {
    var key = quantHue(hue);
    if (glowCache[key]) return glowCache[key];
    var s = 64;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'hsla(' + key + ', 85%, 92%, 0.95)');
    grad.addColorStop(0.22, 'hsla(' + key + ', 88%, 76%, 0.55)');
    grad.addColorStop(0.55, 'hsla(' + key + ', 88%, 64%, 0.16)');
    grad.addColorStop(1, 'hsla(' + key + ', 88%, 60%, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    glowCache[key] = c;
    return c;
  }

  function starSprite(hue) {
    var key = quantHue(hue);
    if (starCache[key]) return starCache[key];
    var s = 64, cx = s / 2;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var g = c.getContext('2d');
    function ray(angle) {
      g.save();
      g.translate(cx, cx);
      g.rotate(angle);
      var grad = g.createLinearGradient(0, -cx + 4, 0, cx - 4);
      grad.addColorStop(0, 'hsla(' + key + ', 90%, 85%, 0)');
      grad.addColorStop(0.5, 'hsla(' + key + ', 90%, 90%, 0.85)');
      grad.addColorStop(1, 'hsla(' + key + ', 90%, 85%, 0)');
      g.strokeStyle = grad;
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(0, -cx + 4);
      g.lineTo(0, cx - 4);
      g.stroke();
      g.restore();
    }
    ray(0); ray(Math.PI / 2);
    var core = g.createRadialGradient(cx, cx, 0, cx, cx, 10);
    core.addColorStop(0, 'hsla(' + key + ', 90%, 95%, 0.95)');
    core.addColorStop(1, 'hsla(' + key + ', 90%, 80%, 0)');
    g.fillStyle = core;
    g.fillRect(cx - 10, cx - 10, 20, 20);
    starCache[key] = c;
    return c;
  }

  /* ---------------- 画布尺寸与环境粒子 ---------------- */

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    fxCanvas.width = Math.round(innerWidth * dpr);
    fxCanvas.height = Math.round(innerHeight * dpr);
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgCanvas.width = Math.round(innerWidth * dpr);
    bgCanvas.height = Math.round(innerHeight * dpr);
    bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    initAmbient();
  }

  function initAmbient() {
    dust = [];
    var n = Math.round((innerWidth * innerHeight) / 34000);
    for (var i = 0; i < n; i++) {
      dust.push({
        x: Math.random() * innerWidth,
        y: Math.random() * innerHeight,
        r: 0.6 + Math.random() * 1.7,
        vx: 3 + Math.random() * 8,
        vy: -2 - Math.random() * 5,
        a: 0.025 + Math.random() * 0.055,
        tw: Math.random() * Math.PI * 2
      });
    }
    // 大型柔光光斑（散景）
    bokeh = [];
    var bn = Math.max(4, Math.round(innerWidth / 300));
    for (var j = 0; j < bn; j++) {
      bokeh.push({
        x: Math.random() * innerWidth,
        y: Math.random() * innerHeight,
        r: 40 + Math.random() * 90,
        vx: 1.5 + Math.random() * 3.5,
        vy: -0.8 - Math.random() * 2,
        a: 0.02 + Math.random() * 0.035,
        hue: [215, 250, 40, 175][j % 4] + Math.random() * 14
      });
    }
  }

  /* ---------------- 主循环 ---------------- */

  function ensureLoop() {
    if (running) return;
    running = true;
    lastT = performance.now();
    requestAnimationFrame(loop);
  }

  function loop(now) {
    var dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    time += dt;

    var alive = false;
    fxCtx.clearRect(0, 0, innerWidth, innerHeight);

    if (particles.length) {
      fxCtx.globalCompositeOperation = 'lighter';
      for (var i = particles.length - 1; i >= 0; i--) {
        var p = particles[i];
        p.life -= dt;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        alive = true;
        p.x += (p.vx || 0) * dt;
        p.y += (p.vy || 0) * dt;
        if (p.rotV) p.rot += p.rotV * dt;
        if (p.type === 'glyph' || p.type === 'orb') p.x += Math.sin(p.life * p.sway + p.phase) * p.swayAmp * dt;
        drawParticle(p);
      }
      fxCtx.globalCompositeOperation = 'source-over';
    }

    drawAmbient(dt);

    if (particles.length) {
      requestAnimationFrame(loop);
    } else {
      // 只剩背景时降频绘制
      setTimeout(function () { requestAnimationFrame(loop); }, 66);
    }
  }

  function drawParticle(p) {
    var k = Math.max(0, Math.min(1, p.life / p.maxLife));
    var ease = k * k * (3 - 2 * k); // 平滑淡出

    if (p.type === 'beam') {
      var h = p.h0 * (0.3 + 0.7 * (1 - ease));
      var grad = fxCtx.createLinearGradient(p.x, p.y, p.x, p.y - h);
      grad.addColorStop(0, 'hsla(' + p.hue + ', 85%, 78%, ' + (0.5 * k) + ')');
      grad.addColorStop(0.75, 'hsla(' + p.hue + ', 90%, 68%, ' + (0.16 * k) + ')');
      grad.addColorStop(1, 'hsla(' + p.hue + ', 90%, 62%, 0)');
      fxCtx.fillStyle = grad;
      roundRect(p.x - p.w / 2, p.y - h, p.w, h, p.w / 2);
      // 光束头部亮核（微微闪烁）
      var headY = p.y - h;
      var tw = 0.8 + 0.2 * Math.sin(time * 14 + p.phase);
      drawSprite(glowSprite(p.hue), p.x, headY, p.w * (2.6 + 0.6 * tw), 0.5 * k * tw);
    } else if (p.type === 'spark') {
      drawSprite(glowSprite(p.hue), p.x, p.y, p.size * (0.6 + 0.7 * k), k);
    } else if (p.type === 'star') {
      var twk = 0.55 + 0.45 * Math.sin(time * 11 + p.phase);
      fxCtx.save();
      fxCtx.translate(p.x, p.y);
      fxCtx.rotate(p.rot);
      var sc = p.size * (0.4 + 0.6 * k);
      fxCtx.globalAlpha = Math.max(0, Math.min(1, k * twk));
      fxCtx.drawImage(starSprite(p.hue), -sc, -sc, sc * 2, sc * 2);
      fxCtx.restore();
      fxCtx.globalAlpha = 1;
    } else if (p.type === 'orb') {
      fxCtx.globalAlpha = Math.max(0, 0.5 * k);
      var os = p.size * (1.3 - 0.5 * k);
      fxCtx.drawImage(glowSprite(p.hue), p.x - os / 2, p.y - os / 2, os, os);
      fxCtx.globalAlpha = 1;
    } else if (p.type === 'ring') {
      var r = p.r0 + (1 - k) * p.r1;
      fxCtx.strokeStyle = 'hsla(' + p.hue + ', 80%, 74%, ' + (0.35 * k) + ')';
      fxCtx.lineWidth = 1.4;
      fxCtx.beginPath();
      fxCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
      fxCtx.stroke();
      fxCtx.strokeStyle = 'hsla(' + p.hue + ', 80%, 82%, ' + (0.16 * k) + ')';
      fxCtx.beginPath();
      fxCtx.arc(p.x, p.y, r * 0.7, 0, Math.PI * 2);
      fxCtx.stroke();
    } else if (p.type === 'glyph') {
      fxCtx.save();
      var gs = p.size * (0.8 + 0.4 * k);
      drawSprite(glowSprite(p.hue), p.x, p.y, gs * 2.6, 0.35 * k);
      fxCtx.globalAlpha = 0.9 * k;
      fxCtx.font = gs + 'px Georgia, serif';
      fxCtx.fillStyle = 'hsla(' + p.hue + ', 75%, 86%, 0.95)';
      fxCtx.textAlign = 'center';
      fxCtx.fillText(p.ch, p.x, p.y);
      fxCtx.restore();
      fxCtx.globalAlpha = 1;
    }
  }

  function drawSprite(sprite, x, y, size, alpha) {
    fxCtx.globalAlpha = Math.max(0, Math.min(1, alpha));
    fxCtx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    fxCtx.globalAlpha = 1;
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, Math.abs(h) / 2);
    fxCtx.beginPath();
    fxCtx.moveTo(x + r, y);
    fxCtx.arcTo(x + w, y, x + w, y + h, r);
    fxCtx.arcTo(x + w, y + h, x, y + h, r);
    fxCtx.arcTo(x, y + h, x, y, r);
    fxCtx.arcTo(x, y, x + w, y, r);
    fxCtx.closePath();
    fxCtx.fill();
  }

  function drawAmbient(dt) {
    bgCtx.clearRect(0, 0, innerWidth, innerHeight);
    // 散景光斑
    bgCtx.globalCompositeOperation = 'lighter';
    for (var b = 0; b < bokeh.length; b++) {
      var o = bokeh[b];
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      if (o.x - o.r > innerWidth) { o.x = -o.r; o.y = Math.random() * innerHeight; }
      if (o.y + o.r < 0) { o.y = innerHeight + o.r; o.x = Math.random() * innerWidth; }
      var oa = o.a * (0.75 + 0.25 * Math.sin(time * 0.6 + b * 1.7));
      bgCtx.globalAlpha = oa;
      var sp = glowSprite(o.hue);
      bgCtx.drawImage(sp, o.x - o.r, o.y - o.r, o.r * 2, o.r * 2);
    }
    bgCtx.globalCompositeOperation = 'source-over';
    bgCtx.globalAlpha = 1;
    // 微尘
    for (var i = 0; i < dust.length; i++) {
      var d = dust[i];
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.x > innerWidth + 4) d.x = -4;
      if (d.y < -4) d.y = innerHeight + 4;
      var a = d.a * (0.7 + 0.3 * Math.sin(time * 0.8 + d.tw));
      bgCtx.fillStyle = 'rgba(220, 214, 188, ' + a + ')';
      bgCtx.beginPath();
      bgCtx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      bgCtx.fill();
    }
  }

  /** 按键触发：在琴键位置生成一组梦幻粒子（x, yTop 为琴键顶部中心的屏幕坐标） */
  function keyPress(midi, x, yTop, isBlack) {
    ensureLoop();
    if (!settings.enabled) return;
    var hue = hueFor(midi);
    var inten = settings.intensity;
    var w = isBlack ? 14 : 20;

    particles.push({
      type: 'beam', x: x, y: yTop, w: w, hue: hue,
      h0: 170 + Math.random() * 140,
      vx: 0, vy: -55 - Math.random() * 45,
      phase: Math.random() * Math.PI * 2,
      life: 1.35 + Math.random() * 0.55, maxLife: 1.75
    });

    var sparks = Math.round(8 * inten);
    for (var i = 0; i < sparks; i++) {
      var isStar = Math.random() < 0.32;
      var base = {
        x: x + (Math.random() - 0.5) * w * 1.8, y: yTop - Math.random() * 14,
        vx: (Math.random() - 0.5) * 100, vy: -70 - Math.random() * 170,
        hue: hue + (Math.random() - 0.5) * 30,
        phase: Math.random() * Math.PI * 2,
        life: 0.9 + Math.random() * 0.9, maxLife: 1.6
      };
      if (isStar) {
        particles.push(Object.assign(base, {
          type: 'star', size: 5 + Math.random() * 9,
          rot: Math.random() * Math.PI, rotV: (Math.random() - 0.5) * 2.4
        }));
      } else {
        particles.push(Object.assign(base, { type: 'spark', size: 4 + Math.random() * 9 }));
      }
    }

    particles.push({
      type: 'ring', x: x, y: yTop + 4, r0: 3, r1: 48 + Math.random() * 26, hue: hue,
      life: 0.7, maxLife: 0.7
    });

    // 上升光球（梦境感的主角）
    var orbs = Math.round(2 * inten);
    for (var o = 0; o < orbs; o++) {
      particles.push({
        type: 'orb',
        x: x + (Math.random() - 0.5) * w * 2.4, y: yTop - Math.random() * 8,
        vx: (Math.random() - 0.5) * 12, vy: -30 - Math.random() * 34,
        size: 30 + Math.random() * 50,
        hue: hue + (Math.random() - 0.5) * 36,
        phase: Math.random() * Math.PI * 2,
        sway: 1.4 + Math.random(), swayAmp: 18 + Math.random() * 24,
        life: 2.4 + Math.random() * 1.5, maxLife: 3.6
      });
    }

    if (Math.random() < 0.5 * inten) {
      particles.push({
        type: 'glyph', x: x + (Math.random() - 0.5) * 26, y: yTop - 10,
        vx: (Math.random() - 0.5) * 22, vy: -36 - Math.random() * 28,
        ch: Math.random() < 0.28 ? '♫' : '♪',
        size: 13 + Math.random() * 9, hue: hue,
        phase: Math.random() * Math.PI * 2,
        sway: 5, swayAmp: 22,
        life: 1.9 + Math.random() * 0.6, maxLife: 2.3
      });
    }
  }

  window.FX = {
    keyPress: keyPress,
    settings: settings,
    resize: resize,
    hueFor: hueFor
  };
})();
