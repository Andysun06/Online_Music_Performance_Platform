/* ============================================================
 * effects.js — 视觉特效
 *
 *  - 前景画布（#fx）：按键触发的光束、火花、涟漪、漂浮音符。
 *  - 背景画布（#fxBg）：缓慢漂浮的微尘，营造音乐厅空气感。
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
  var running = false;
  var lastT = 0;

  function hueFor(midi) { return (midi % 12) * 30 + 190; }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    fxCanvas.width = Math.round(innerWidth * dpr);
    fxCanvas.height = Math.round(innerHeight * dpr);
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgCanvas.width = Math.round(innerWidth * dpr);
    bgCanvas.height = Math.round(innerHeight * dpr);
    bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    initDust();
  }

  function initDust() {
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
  }

  function ensureLoop() {
    if (running) return;
    running = true;
    lastT = performance.now();
    requestAnimationFrame(loop);
  }

  function loop(now) {
    var dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;

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
        if (p.type === 'glyph') p.x += Math.sin(p.life * 6 + p.phase) * 22 * dt;
        drawParticle(p);
      }
      fxCtx.globalCompositeOperation = 'source-over';
    }

    drawDust(dt, now / 1000);

    if (alive || particles.length) {
      requestAnimationFrame(loop);
    } else {
      // 只保留背景微尘时进入低频绘制
      running = true;
      setTimeout(function () { requestAnimationFrame(loop); }, 66);
    }
  }

  function drawParticle(p) {
    var k = Math.max(0, Math.min(1, p.life / p.maxLife)); // 1 -> 0
    fxCtx.globalAlpha = k;

    if (p.type === 'beam') {
      var h = p.h0 * (0.35 + 0.65 * (1 - k));
      var grad = fxCtx.createLinearGradient(p.x, p.y, p.x, p.y - h);
      grad.addColorStop(0, 'hsla(' + p.hue + ', 90%, 72%, ' + (0.55 * k) + ')');
      grad.addColorStop(1, 'hsla(' + p.hue + ', 90%, 60%, 0)');
      fxCtx.fillStyle = grad;
      roundRect(p.x - p.w / 2, p.y - h, p.w, h, p.w / 2);
    } else if (p.type === 'spark') {
      fxCtx.fillStyle = 'hsl(' + p.hue + ', 95%, ' + (62 + 20 * k) + '%)';
      fxCtx.beginPath();
      fxCtx.arc(p.x, p.y, p.size * (0.5 + 0.5 * k), 0, Math.PI * 2);
      fxCtx.fill();
    } else if (p.type === 'ring') {
      var r = p.r0 + (1 - k) * p.r1;
      fxCtx.strokeStyle = 'hsla(' + p.hue + ', 85%, 70%, ' + (0.5 * k) + ')';
      fxCtx.lineWidth = 1.6;
      fxCtx.beginPath();
      fxCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
      fxCtx.stroke();
    } else if (p.type === 'glyph') {
      fxCtx.font = p.size + 'px Georgia, serif';
      fxCtx.fillStyle = 'hsla(' + p.hue + ', 80%, 78%, ' + (0.8 * k) + ')';
      fxCtx.textAlign = 'center';
      fxCtx.fillText(p.ch, p.x, p.y);
    }
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

  function drawDust(dt, t) {
    bgCtx.clearRect(0, 0, innerWidth, innerHeight);
    for (var i = 0; i < dust.length; i++) {
      var d = dust[i];
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.x > innerWidth + 4) d.x = -4;
      if (d.y < -4) d.y = innerHeight + 4;
      var a = d.a * (0.7 + 0.3 * Math.sin(t * 0.8 + d.tw));
      bgCtx.fillStyle = 'rgba(220, 210, 180, ' + a + ')';
      bgCtx.beginPath();
      bgCtx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      bgCtx.fill();
    }
  }

  /** 按键触发：在琴键位置生成一组粒子（x, yTop 为琴键顶部中心的屏幕坐标） */
  function keyPress(midi, x, yTop, isBlack) {
    if (!settings.enabled) { ensureLoop(); return; }
    var hue = hueFor(midi);
    var inten = settings.intensity;
    var w = isBlack ? 14 : 20;

    particles.push({
      type: 'beam', x: x, y: yTop, w: w, hue: hue,
      h0: 90 + Math.random() * 70,
      vx: 0, vy: -55 - Math.random() * 45,
      life: 0.75 + Math.random() * 0.25, maxLife: 1
    });

    var sparks = Math.round(7 * inten);
    for (var i = 0; i < sparks; i++) {
      particles.push({
        type: 'spark', x: x + (Math.random() - 0.5) * w * 1.6, y: yTop - Math.random() * 12,
        vx: (Math.random() - 0.5) * 90, vy: -60 - Math.random() * 130,
        size: 1 + Math.random() * 2.1, hue: hue + (Math.random() - 0.5) * 26,
        life: 0.5 + Math.random() * 0.55, maxLife: 1
      });
    }

    particles.push({
      type: 'ring', x: x, y: yTop + 4, r0: 3, r1: 34 + Math.random() * 18, hue: hue,
      life: 0.5, maxLife: 0.5
    });

    if (Math.random() < 0.45 * inten) {
      particles.push({
        type: 'glyph', x: x + (Math.random() - 0.5) * 26, y: yTop - 10,
        vx: (Math.random() - 0.5) * 24, vy: -46 - Math.random() * 34,
        ch: Math.random() < 0.28 ? '♫' : '♪',
        size: 13 + Math.random() * 9, hue: hue,
        phase: Math.random() * Math.PI * 2,
        life: 1.3 + Math.random() * 0.5, maxLife: 1.7
      });
    }
    ensureLoop();
  }

  window.FX = {
    keyPress: keyPress,
    settings: settings,
    resize: resize,
    hueFor: hueFor
  };
})();
