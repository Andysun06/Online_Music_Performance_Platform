/* ============================================================
 * keyboard-map.js — 电脑键盘 -> 钢琴键位映射
 *
 * 三套预设 + 任意自定义重绑 + 八度整体平移。
 * 使用 KeyboardEvent.code（物理键位），与输入法 / 大小写无关。
 * ============================================================ */
(function () {
  'use strict';

  var OCTAVE_MIN = -2, OCTAVE_MAX = 2;

  // 各预设：code -> midi（标准音高编号，C4 = 60）
  var PRESETS = {
    standard: {
      name: '标准 · 三组音（半音连续）',
      desc: '下排 Z~/ 与上排 Q~] 连续覆盖 C3–B5 共三个八度，黑键在数字行，与 LMMS / Multiplayer Piano 风格一致。',
      map: {
        KeyZ: 48, KeyS: 49, KeyX: 50, KeyD: 51, KeyC: 52, KeyV: 53,
        KeyG: 54, KeyB: 55, KeyH: 56, KeyN: 57, KeyJ: 58, KeyM: 59,
        Comma: 60, KeyL: 61, Period: 62, Semicolon: 63, Slash: 64,
        KeyQ: 65, Digit2: 66, KeyW: 67, Digit3: 68, KeyE: 69, KeyR: 70,
        Digit5: 71, KeyT: 72, Digit6: 73, KeyY: 74, Digit7: 75, KeyU: 76,
        KeyI: 77, Digit9: 78, KeyO: 79, Digit0: 80, KeyP: 81,
        BracketLeft: 82, BracketRight: 83
      }
    },
    compact: {
      name: '紧凑 · 两组音',
      desc: '下排 Z 行为低八度（C3–B3），上排 Q 行为中高八度（C4–B4），双手自然摆放。',
      map: {
        KeyZ: 48, KeyS: 49, KeyX: 50, KeyD: 51, KeyC: 52, KeyV: 53,
        KeyG: 54, KeyB: 55, KeyH: 56, KeyN: 57, KeyJ: 58, KeyM: 59,
        KeyQ: 60, Digit2: 61, KeyW: 62, Digit3: 63, KeyE: 64, KeyR: 65,
        Digit5: 66, KeyT: 67, Digit6: 68, KeyY: 69, Digit7: 70, KeyU: 71
      }
    },
    simple: {
      name: '简易 · 白键字母',
      desc: '字母行 A~\' 为白键 C4–F5，W/E/T/Y/U/O/P 为黑键；下排 Z 行附带低八度白键，适合新手。',
      map: {
        KeyZ: 48, KeyX: 50, KeyC: 52, KeyV: 53, KeyB: 55, KeyN: 57,
        KeyM: 59, Comma: 60, Period: 62, Slash: 64,
        KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64, KeyF: 65,
        KeyT: 66, KeyG: 67, KeyY: 68, KeyH: 69, KeyU: 70, KeyJ: 71,
        KeyK: 72, KeyO: 73, KeyL: 74, KeyP: 75, Semicolon: 76, Quote: 77,
        BracketRight: 78
      }
    }
  };

  var SPECIAL_LABELS = {
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
    Space: 'Space', Backslash: '\\'
  };

  var STORE_KEY = 'resonance.keyboard.v1';

  var state = {
    preset: 'standard',
    custom: {},   // code -> midi 覆盖
    octave: 0     // 整体八度平移
  };

  try {
    var saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) {
      if (PRESETS[saved.preset]) state.preset = saved.preset;
      if (saved.custom && typeof saved.custom === 'object') state.custom = saved.custom;
      if (typeof saved.octave === 'number') state.octave = clampOctave(saved.octave);
    }
  } catch (e) { /* 忽略损坏的本地存储 */ }

  function clampOctave(o) { return Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, o)); }

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function baseMap() {
    var m = {};
    var p = PRESETS[state.preset].map;
    for (var k in p) m[k] = p[k];
    for (var c in state.custom) m[c] = state.custom[c];
    return m;
  }

  /** 实际生效映射（含八度平移，越界键会被过滤） */
  function effectiveMap() {
    var m = baseMap(), out = {};
    for (var code in m) {
      var n = m[code] + state.octave * 12;
      if (n >= 21 && n <= 108) out[code] = n;
    }
    return out;
  }

  function noteForCode(code) { return effectiveMap()[code]; }

  /** 由音名反查绑定的物理键（用于琴键上显示字母） */
  function codeForNote(midi) {
    var m = baseMap();
    for (var code in m) if (m[code] + state.octave * 12 === midi) return code;
    return null;
  }

  function codeLabel(code) {
    if (!code) return '';
    if (SPECIAL_LABELS[code]) return SPECIAL_LABELS[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad\d$/.test(code)) return 'Num' + code.slice(6);
    if (/^Arrow/.test(code)) return ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' })[code];
    return code;
  }

  function setPreset(id) {
    if (!PRESETS[id]) return;
    state.preset = id;
    state.custom = {};
    persist();
  }

  function setBinding(code, midi) {
    if (!code) return;
    var base = PRESETS[state.preset].map;
    if (base[code] === midi) delete state.custom[code];
    else state.custom[code] = midi;
    persist();
  }

  function reset() {
    state.custom = {};
    state.octave = 0;
    persist();
  }

  function shiftOctave(delta) {
    state.octave = clampOctave(state.octave + delta);
    persist();
    return state.octave;
  }

  function midiName(midi) {
    var NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
  }

  function rangeLabel() {
    var m = effectiveMap();
    var min = Infinity, max = -Infinity;
    for (var c in m) { if (m[c] < min) min = m[c]; if (m[c] > max) max = m[c]; }
    if (min === Infinity) return '—';
    return midiName(min) + ' – ' + midiName(max);
  }

  window.KeyboardMap = {
    PRESETS: PRESETS,
    state: state,
    noteForCode: noteForCode,
    codeForNote: codeForNote,
    codeLabel: codeLabel,
    setPreset: setPreset,
    setBinding: setBinding,
    reset: reset,
    shiftOctave: shiftOctave,
    midiName: midiName,
    rangeLabel: rangeLabel,
    isBlack: function (midi) { return [1, 3, 6, 8, 10].indexOf(midi % 12) >= 0; }
  };
})();
