/* ============================================================
 * piano-ui.js — 88 键钢琴渲染与交互
 *
 *  - 完整 A0–C8 琴键，横向滚动；键盘可映射区域有金色虚线框提示。
 *  - 鼠标 / 触摸：按下发音，横向滑动可刮奏（glissando）。
 *  - 键位字母 / 音名标签可独立开关。
 *  - press/release 带引用计数：键盘、鼠标、自动演奏同时按同一键不冲突。
 * ============================================================ */
(function () {
  'use strict';

  var LOW = 21, HIGH = 108; // A0 – C8
  var keyEls = new Map();       // midi -> element
  var pressRefs = new Map();    // midi -> Set(sourceId)
  var labelMode = { keys: true, notes: false };
  var pointerNotes = new Map(); // pointerId -> midi

  var pianoEl = document.getElementById('piano');
  var scrollEl = document.getElementById('pianoScroll');
  var kbRangeEl = document.getElementById('kbRange');

  function isBlack(midi) { return [1, 3, 6, 8, 10].indexOf(midi % 12) >= 0; }

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function noteName(midi) { return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1); }

  function build() {
    var whiteIndex = 0;
    var frag = document.createDocumentFragment();
    for (var midi = LOW; midi <= HIGH; midi++) {
      if (isBlack(midi)) continue;
      var el = document.createElement('div');
      el.className = 'key white';
      el.dataset.midi = String(midi);
      el.style.setProperty('--glow', glowColor(midi, false));
      el.appendChild(document.createElement('span')).className = 'kb-chip';
      el.appendChild(document.createElement('span')).className = 'note-name';
      frag.appendChild(el);
      keyEls.set(midi, el);
      whiteIndex++;
    }
    // 黑键按白色键边界绝对定位
    var wIdx = 0;
    for (var m = LOW; m <= HIGH; m++) {
      if (!isBlack(m)) { wIdx++; continue; }
      var bk = document.createElement('div');
      bk.className = 'key black';
      bk.dataset.midi = String(m);
      bk.style.setProperty('--glow', glowColor(m, true));
      bk.style.left = (wIdx * cssWkey() - cssBkey() / 2) + 'px';
      bk.appendChild(document.createElement('span')).className = 'kb-chip';
      bk.appendChild(document.createElement('span')).className = 'note-name';
      frag.appendChild(bk);
      keyEls.set(m, bk);
    }
    pianoEl.appendChild(frag);
    pianoEl.style.width = (whiteIndex * cssWkey()) + 'px';
    updateLabels();
  }

  function cssVarPx(name) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return parseFloat(v) || 0;
  }
  function cssWkey() { return cssVarPx('--wkey-w'); }
  function cssBkey() { return cssVarPx('--bkey-w'); }

  function glowColor(midi, isBlackKey) {
    var hue = (window.FX ? window.FX.hueFor(midi) : (midi % 12) * 30 + 190);
    return 'hsla(' + hue + ', 85%, ' + (isBlackKey ? 62 : 68) + '%, 0.55)';
  }

  function updateLabels() {
    keyEls.forEach(function (el, midi) {
      var chip = el.querySelector('.kb-chip');
      var name = el.querySelector('.note-name');
      var code = window.KeyboardMap.codeForNote(midi);
      chip.textContent = code ? window.KeyboardMap.codeLabel(code) : '';
      name.textContent = noteName(midi);
    });
    pianoEl.classList.toggle('no-keys', !labelMode.keys);
    pianoEl.classList.toggle('no-notes', !labelMode.notes);
  }

  function setLabelMode(showKeys, showNotes) {
    labelMode.keys = showKeys;
    labelMode.notes = showNotes;
    updateLabels();
  }

  function refreshKeyGlows() {
    keyEls.forEach(function (el, midi) {
      el.style.setProperty('--glow', glowColor(midi, isBlack(midi)));
    });
  }

  /* ---------------- 按压状态（引用计数） ---------------- */

  function press(midi, sourceId) {
    var set = pressRefs.get(midi) || new Set();
    var fresh = set.size === 0;
    set.add(sourceId || 'anon');
    pressRefs.set(midi, set);
    if (fresh) {
      var el = keyEls.get(midi);
      if (el) {
        el.classList.add('pressed');
        var rect = el.getBoundingClientRect();
        window.FX.keyPress(midi, rect.left + rect.width / 2, rect.top + 2, isBlack(midi));
      }
    }
  }

  function release(midi, sourceId) {
    var set = pressRefs.get(midi);
    if (!set) return;
    set.delete(sourceId || 'anon');
    if (set.size === 0) {
      pressRefs.delete(midi);
      var el = keyEls.get(midi);
      if (el) el.classList.remove('pressed');
    }
  }

  function releaseAll(sourceId) {
    pressRefs.forEach(function (set, midi) {
      if (set.delete(sourceId) && set.size === 0) {
        pressRefs.delete(midi);
        var el = keyEls.get(midi);
        if (el) el.classList.remove('pressed');
      }
    });
  }

  /** 全部视觉复位（Esc 急停等场景） */
  function clearAllVisual() {
    pressRefs.clear();
    keyEls.forEach(function (el) { el.classList.remove('pressed'); });
  }

  /* ---------------- 鼠标 / 触摸演奏 ---------------- */

  function midiFromPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el !== pianoEl) {
      if (el.classList && el.classList.contains('key')) return parseInt(el.dataset.midi, 10);
      el = el.parentElement;
    }
    return null;
  }

  function onPointerDown(e) {
    var midi = midiFromPoint(e.clientX, e.clientY);
    if (midi == null) return;
    e.preventDefault();
    pointerNotes.set(e.pointerId, midi);
    window.App.noteOn(midi, velocityFromY(e, midi), 'mouse');
    scrollEl.style.scrollBehavior = 'auto';
  }

  function velocityFromY(e, midi) {
    // 按键越靠下（越靠近琴键外沿）力度越大，模拟真实触键
    var el = keyEls.get(midi);
    if (!el) return 0.85;
    var rect = el.getBoundingClientRect();
    var k = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return 0.45 + k * 0.5;
  }

  function onPointerMove(e) {
    if (!pointerNotes.has(e.pointerId)) return;
    var midi = midiFromPoint(e.clientX, e.clientY);
    var prev = pointerNotes.get(e.pointerId);
    if (midi === prev) return;
    if (prev != null) window.App.noteOff(prev, 'mouse');
    if (midi != null) {
      pointerNotes.set(e.pointerId, midi);
      window.App.noteOn(midi, 0.82, 'mouse');
    } else {
      pointerNotes.delete(e.pointerId);
    }
  }

  function onPointerUp(e) {
    var prev = pointerNotes.get(e.pointerId);
    if (prev != null) {
      window.App.noteOff(prev, 'mouse');
      pointerNotes.delete(e.pointerId);
    }
  }

  function bindPointer() {
    pianoEl.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    pianoEl.style.touchAction = 'none';
  }

  /* ---------------- 键盘映射范围指示 ---------------- */

  function setKeyboardRange(minMidi, maxMidi) {
    var x1 = midiLeftX(minMidi), x2 = midiLeftX(maxMidi);
    var blackMax = isBlack(maxMidi);
    var left = x1;
    var width = (x2 + (blackMax ? cssBkey() : cssWkey())) - x1;
    kbRangeEl.style.left = left + 'px';
    kbRangeEl.style.width = width + 'px';
  }

  function midiLeftX(midi) {
    if (isBlack(midi)) {
      var whites = 0;
      for (var m = LOW; m < midi; m++) if (!isBlack(m)) whites++;
      return whites * cssWkey() - cssBkey() / 2;
    }
    var w = 0;
    for (var n = LOW; n < midi; n++) if (!isBlack(n)) w++;
    return w * cssWkey();
  }

  /** 键盘弹奏时若该键在可视区外，自动滚动到可见 */
  function ensureVisible(midi) {
    var el = keyEls.get(midi);
    if (!el) return;
    var r = el.getBoundingClientRect();
    var sr = scrollEl.getBoundingClientRect();
    if (r.left < sr.left + 8 || r.right > sr.right - 8) {
      scrollEl.scrollLeft += (r.left + r.width / 2) - (sr.left + sr.width / 2);
    }
  }

  window.PianoUI = {
    build: build,
    press: press,
    release: release,
    releaseAll: releaseAll,
    clearAllVisual: clearAllVisual,
    setLabelMode: setLabelMode,
    updateLabels: updateLabels,
    refreshKeyGlows: refreshKeyGlows,
    setKeyboardRange: setKeyboardRange,
    ensureVisible: ensureVisible,
    bindPointer: bindPointer,
    keyEls: keyEls,
    isBlack: isBlack,
    noteName: noteName
  };
})();
